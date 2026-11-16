// devcontrol — 控制台「重采验收命令」必须能填多条
//
// 为什么值得一条测试：全栈项目一条验收不够（测试要过 + 构建要过）。
// 数据层（path.retest 的 testCmds 数组）早就支持，卡的是表单只收一条，
// 于是 Owner 只能在「跑测试」和「跑构建」之间二选一，另一条永远没人跑。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db.js";
import { pathRetest } from "../src/store.js";
import { makeRepo, initFlow } from "./helpers.js";

const HTML = path.join(import.meta.dirname, "..", "public", "index.html");
const script = fs.readFileSync(HTML, "utf8").match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

const retestBlock = () => script.slice(script.indexOf('if (b.dataset.retest)'), script.indexOf('if (b.dataset.memAccept)'));

test("重采表单是多行输入，按行拆成多条命令", () => {
  const block = retestBlock();
  assert.ok(block.includes('type: "textarea"'), "验收命令要能填多行（text 只能一行）");
  assert.ok(block.includes('.split("\\n")'), "提交时按行拆成命令数组");
  assert.ok(!/请只填一条/.test(block), "不能再告诉 Owner 只填一条");
});

test("表单回填时把已有的多条命令分行摆出来，不吞掉后面的", () => {
  const block = retestBlock();
  assert.ok(block.includes("cur.join("), "回填要保留全部命令，不能只回填第一条");
});

test("path.retest 真的能冻进两条命令，并一起进契约", async () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const r = pathRetest(db, root, {
    pathId: "P-001",
    testCmds: ["npm test", "npm run build"],
    reason: "全栈项目里测试和构建都要过，少一条就等于没验收",
  });
  assert.deepEqual(r.to, ["npm test", "npm run build"]);
  // 契约里存的是完整数组，不是第一条
  const row = db.prepare("SELECT test_cmds_json FROM paths WHERE id='P-001'").get();
  assert.deepEqual(JSON.parse(row.test_cmds_json), ["npm test", "npm run build"]);
});

test("空行和首尾空白不会变成一条空命令", async () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const r = pathRetest(db, root, {
    pathId: "P-001",
    testCmds: ["  npm test  ", "", "   ", "npm run build"],
    reason: "从控制台的多行输入过来，中间的空行不该变成验收命令",
  });
  assert.deepEqual(r.to, ["npm test", "npm run build"]);
});
