// devcontrol — 标记残留：内核只记录，不拦人
//
// 这条规范曾经是拦截项，而且只看词根，连内核自己写的一条说明文案都被它拦住过。
// 现在的定位是：**规范下发，内核只数事实**——
// 收口时告诉你「留下了 2 处标记」，判不判由 Owner；不阻断交付。
//
// 这条测试守两件事：① 只认「注释开头」的标记（提到这个词不算）；
// ② 观测到了也不能拦（close 必须成功）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, initFlow, newTask, prove } from "./helpers.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { commitFiles } from "../src/git.js";

// 源码里不能直接写「注释符 + 标记词」的字面量：否则这条规则自身的夹具会被记一笔。
// 这不是为了绕过检查，而是「内核也会数自己的代码」这件事的必然结果。
const SLASH = "//";
const HASH = "#";
const BLOCK = "/*";
const HTML = "<!--";
const word = (w) => w;

/** 领任务 → 写文件 → 提交 → 交证据 → 收口，返回 close 结果 */
async function closeWithFile(root, db, task, rel, body) {
  taskClaim(db, root, { id: task.id }, "agent");
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  commitFiles(root, [rel], `feat: x\n\nTask-Id: ${task.id}`, { author: "agent" });
  prove(db, root, task.id);
  return taskClose(db, root, { id: task.id, resolvedBy: "按提示改掉" });
}

const todoObs = (res) => (res.observations ?? []).filter((o) => o.id === "todo");

test("注释里留标记：记录一笔，但**不拦**交付", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  const res = await closeWithFile(root, db, task, "src/a.js", `${SLASH} ${word("TODO")} 以后再补校验\nexport const a = 1;\n`);

  assert.ok(res, "收口应当成功——规范只下发，内核不判违规");
  const obs = todoObs(res);
  assert.equal(obs.length, 1, "要如实记下来");
  assert.match(obs[0].detail, /1 处/);
});

test("只在文案里提到这个词：不记（提到 ≠ 留下）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  const body = [
    `${SLASH} 这条规则的意思是：别把活留成标记。`,
    `export const HINT = "先做成真实现，或者写进 issue（例如 ${word("TODO")}/${word("FIXME")}）";`,
    "export const a = 1;",
    "",
  ].join("\n");
  const res = await closeWithFile(root, db, task, "src/a.js", body);
  assert.deepEqual(todoObs(res), [], "文案里提到不算留下标记");
});

test("四种注释符都认", async () => {
  const probes = [
    ["src/a.js", `${SLASH} ${word("FIXME")} 先这样\n`],
    ["src/b.py", `${HASH} ${word("HACK")} 临时绕过\n`],
    ["src/c.js", `${BLOCK} ${word("XXX")} 别学这个 */\n`],
    ["src/d.html", `${HTML} ${word("HACK")} 占位 -->\n`],
  ];
  for (const [rel, body] of probes) {
    const root = makeRepo();
    const { db, reqId } = initFlow(root);
    const task = newTask(db, root, reqId);
    const res = await closeWithFile(root, db, task, rel, body);
    assert.equal(todoObs(res).length, 1, `${rel} 应该被记一笔`);
  }
});

test("普通标识符里的字母组合不算标记", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  const res = await closeWithFile(root, db, task, "src/a.js", `export const ${word("TODO")}_LIST = [];\nexport const a = 1;\n`);
  assert.deepEqual(todoObs(res), []);
});

test("多笔标记合并成一条观测（不是刷屏）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  const body = [`${SLASH} ${word("TODO")} 一`, `${SLASH} ${word("FIXME")} 二`, "export const a = 1;", ""].join("\n");
  const res = await closeWithFile(root, db, task, "src/a.js", body);
  const obs = todoObs(res);
  assert.equal(obs.length, 1, "同一类问题一条就够");
  assert.match(obs[0].detail, /2 处/);
});