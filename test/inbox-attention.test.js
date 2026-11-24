// devcontrol — 收件箱去噪（P1-5）
//
// 老板视角：一打开控制台，待办里全是「某某任务已挂起 · 连续失败」，每条都要他点一下
// 「打回重做」。那不是他要决定的事——测试没过、Agent 改代码重跑，本来就该 Agent 自己闭环。
// 他去点，等于把 Agent 的活变成人的活。
import test from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "../src/digest.js";
import { ask, taskClaim } from "../src/gates.js";
import { logEvent } from "../src/db.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";
import { MAX_REWORK } from "../src/rework.js";

function parked({ failure = "E_ASSERTION_FAILED", reworks = 0 } = {}) {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  db.prepare("UPDATE tasks SET status='parked', claimed_by=NULL, claim_expires_at=NULL WHERE id=?").run(task.id);
  logEvent(db, { actor: "agent", action: "close.fail", taskId: task.id, code: failure, detail: failure });
  for (let i = 0; i < reworks; i += 1) logEvent(db, { actor: "agent", action: "task.rework", taskId: task.id, detail: `第 ${i + 1} 次` });
  return { root, db, reqId, task };
}

test("代码类失败挂起：不进 Owner 待办（Agent 自己能救）", () => {
  const { root, db } = parked();
  const a = bootstrap(db, root).attention;
  assert.deepEqual(a, [], `不该占待办：${JSON.stringify(a)}`);
  db.close();
});

test("自主返工用完：进待办，并带上最后一次失败与返工次数", () => {
  const { root, db, task } = parked({ reworks: MAX_REWORK });
  const a = bootstrap(db, root).attention;
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "rework-exhausted");
  assert.equal(a[0].taskId, task.id);
  assert.deepEqual(a[0].attempts, ["E_ASSERTION_FAILED"]);
  assert.equal(a[0].reworks, MAX_REWORK);
  assert.match(a[0].reason, /用完/);
  db.close();
});

test("授权类失败挂起：进待办（只有人能解）", () => {
  const { root, db, task } = parked({ failure: "E_NEED_APPROVED" });
  const a = bootstrap(db, root).attention;
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, "needs-owner");
  assert.equal(a[0].taskId, task.id);
  db.close();
});

test("同一个任务失败五次也只出一条（不是五条）", () => {
  const { root, db, task } = parked();
  for (let i = 0; i < 4; i += 1) logEvent(db, { actor: "agent", action: "close.fail", taskId: task.id, code: "E_ASSERTION_FAILED", detail: `第 ${i + 2} 次` });
  db.prepare("UPDATE tasks SET status='parked' WHERE id=?").run(task.id);
  for (let i = 0; i < MAX_REWORK; i += 1) logEvent(db, { actor: "agent", action: "task.rework", taskId: task.id, detail: "retry" });
  const a = bootstrap(db, root).attention.filter((x) => x.taskId === task.id);
  assert.equal(a.length, 1, `同一任务只能出 ${a.length} 条`);
  db.close();
});

test("待回答的问题也在待办里，且带得上任务号", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  ask(db, { taskId: task.id, question: "要不要删旧接口？不可逆", kind: "owner" });
  const a = bootstrap(db, root).attention.filter((x) => x.kind === "question");
  assert.equal(a.length, 1);
  assert.equal(a[0].taskId, task.id);
  assert.match(a[0].fix, /回答/);
  db.close();
});