// devcontrol — Owner 写在需求验收里的命令，必须在批准时冻进契约
//
// 为什么值得一条测试：批准是「Owner 说话的唯一时刻」。他在需求里写了
// 「npm run build 也要过」，如果批准时只按 Path 采到的那条 npm test 冻结，
// Owner 的话就被静默丢掉了——之后任何任务想用 build 验收都会被 E_CONTRACT 拦住，
// 而 Agent 从错误里看不出「这是 Owner 早就说过的」。
import test from "node:test";
import assert from "node:assert/strict";
import { makeRepo } from "./helpers.js";
import { openDb } from "../src/db.js";
import { reqIntake, reqApprove } from "../src/store.js";
import { taskCreate } from "../src/gates.js";

/** 建一个项目：Path 初始只采到 npm test，但需求要 build */
function flow(root) {
  const db = openDb(root);
  db.prepare(
    "INSERT INTO paths(id,allowed_paths_json,allow_new_files,budget_lines,test_cmds_json,status) VALUES('P-001',?,0,1200,?,'draft')",
  ).run(JSON.stringify(["src"]), JSON.stringify(["npm test"]));
  const req = reqIntake(db, root, {
    type: "requirement",
    title: "构建也要过",
    acceptance: ["npm test :: exit==0", "npm run build :: exit==0"],
  });
  reqApprove(db, root, { requirementId: req.id, pathId: "P-001" });
  return { db, req };
}

/** 只有一条 Path 的极简场景：给「不重复堆积」那条测试用 */
function bareFlow(root) {
  const db = openDb(root);
  db.prepare(
    "INSERT INTO paths(id,allowed_paths_json,allow_new_files,budget_lines,test_cmds_json,status) VALUES('P-001',?,0,1200,?,'draft')",
  ).run(JSON.stringify(["src"]), JSON.stringify(["npm test"]));
  const req = reqIntake(db, root, { type: "requirement", title: "只有 test", acceptance: ["npm test :: exit==0"] });
  reqApprove(db, root, { requirementId: req.id, pathId: "P-001" });
  return { db, req };
}

const cmds = (db) => JSON.parse(db.prepare("SELECT test_cmds_json FROM paths WHERE id='P-001'").get().test_cmds_json);

test("需求验收里的命令会并进 Path 契约，不只是采到的那条", () => {
  const root = makeRepo();
  const { db } = flow(root);
  assert.deepEqual(cmds(db).sort(), ["npm run build", "npm test"]);
});

test("批准后可以建「只断言构建」的任务（全栈项目的正常诉求）", () => {
  const root = makeRepo();
  const { db, req } = flow(root);
  const t = taskCreate(db, root, {
    requirementId: req.id,
    pathId: "P-001",
    kind: "feature",
    title: "前端：渲染",
    scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm run build :: exit==0" }],
  });
  assert.equal(t.acceptance[0].assertion, "npm run build :: exit==0");
});

test("需求验收里的命令不会重复堆进契约", () => {
  const root = makeRepo();
  const { db } = bareFlow(root);
  assert.deepEqual(cmds(db), ["npm test"]);
});

test("批准记录里带的是合并后的契约提交", () => {
  const root = makeRepo();
  const { db } = flow(root);
  const row = db.prepare("SELECT hash, contract_commit FROM paths WHERE id='P-001'").get();
  assert.match(row.hash, /^[0-9a-f]{64}$/);
  assert.match(row.contract_commit, /^[0-9a-f]{40}$/);
});
