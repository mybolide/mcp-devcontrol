// devcontrol — Agent 自主返工（P0-3）
//
// 目标：普通代码失败不许直接把 Owner 叫来。Agent 在同一条合同里可以自己重试，
// 有次数上限；用完就把「试过什么、卡在哪」整理成报告交人。
// 边界：返工**不碰合同**；授权类失败一律交回人。
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, logEvent } from "../src/db.js";
import { now } from "../src/store.js";
import { reworkState, taskRework, taskResume, reworkReport, MAX_REWORK, failureOwner } from "../src/rework.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";

function fixture({ failure = "E_ASSERTION_FAILED", question = false, reworks = 0 } = {}) {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  db.prepare("UPDATE tasks SET status='parked', claimed_by=NULL, claim_expires_at=NULL WHERE id=?").run(task.id);
  if (failure) logEvent(db, { actor: "agent", action: "close.fail", taskId: task.id, code: failure, detail: `第 1 次 ${failure}` });
  for (let i = 0; i < reworks; i += 1) logEvent(db, { actor: "agent", action: "task.rework", taskId: task.id, detail: `第 ${i + 1}/${MAX_REWORK} 次` });
  if (question) db.prepare("INSERT INTO questions(id,task_id,question,options_json,status,expires_at) VALUES('Q-001',?,?, '[]','open',?)").run(task.id, "用哪个方案？", now());
  return { root, db, taskId: task.id };
}

test("普通验收失败 → needs_rework：Agent 可以自己重试，不用惊动 Owner", () => {
  const { db, taskId } = fixture();
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  const st = reworkState(db, { ...t, id: taskId, status: "parked" });
  assert.equal(st.state, "needs_rework");
  assert.equal(st.owner, "agent");
  assert.equal(st.lastFailure.code, "E_ASSERTION_FAILED");
  const res = taskRework(db, { id: taskId, note: "改成先解析再写库" });
  assert.equal(res.status, "backlog");
  assert.equal(res.reworks, 1);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status, "backlog");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE task_id=? AND action='task.rework'").get(taskId).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE task_id=? AND action='task.rework.note'").get(taskId).c, 1);
});

test("授权类失败 → needs_owner：多试几次也不会变，返工被拒", () => {
  const { db, taskId } = fixture({ failure: "E_NEED_APPROVED" });
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  const st = reworkState(db, { ...t, id: taskId, status: "parked" });
  assert.equal(st.state, "needs_owner");
  assert.equal(failureOwner("E_NEED_APPROVED"), "owner");
  assert.throws(() => taskRework(db, { id: taskId }), (e) => e.code === "E_NEEDS_OWNER");
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status, "parked", "被拒时状态不许变");
});

test("有未回答的问题 → needs_owner：等 Owner 一句话，不是自己硬试", () => {
  const { db, taskId } = fixture({ question: true });
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  const st = reworkState(db, { ...t, id: taskId, status: "parked" });
  assert.equal(st.state, "needs_owner");
  assert.match(st.reason, /Q-001/);
  assert.throws(() => taskRework(db, { id: taskId }), (e) => e.code === "E_NEEDS_OWNER");
});

test("自主返工有上限：用完就变成 failed，并交出报告", () => {
  const { db, taskId } = fixture({ reworks: MAX_REWORK });
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  const st = reworkState(db, { ...t, id: taskId, status: "parked" });
  assert.equal(st.state, "failed");
  assert.equal(st.remaining, 0);
  let err = null;
  try {
    taskRework(db, { id: taskId });
  } catch (e) {
    err = e;
  }
  assert.equal(err?.code, "E_REWORK_EXHAUSTED");
  assert.ok(err.data.report, "拒绝时必须带上报告：试过什么、卡在哪");
  assert.equal(err.data.report.attempts.length, 1);
  assert.equal(err.data.report.reworks.length, MAX_REWORK);
  assert.match(err.data.report.hint, /E_ASSERTION_FAILED/);
});

test("返工不许改合同：scope 与契约哈希前后一致", () => {
  const { db, taskId } = fixture();
  const before = db.prepare("SELECT scope_json, contract_hash, base_head, budget_lines FROM tasks WHERE id=?").get(taskId);
  taskRework(db, { id: taskId });
  const after = db.prepare("SELECT scope_json, contract_hash, base_head, budget_lines FROM tasks WHERE id=?").get(taskId);
  assert.deepEqual(after, before, "返工只改状态，合同一个字都不能动");
});

test("只有挂起的任务能返工：在办/待办各有各的路", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  assert.throws(() => taskRework(db, { id: task.id }), (e) => e.code === "E_ILLEGAL_TRANSITION", "backlog 直接 claim 就行");
});

test("崩溃恢复：租约过期才能 resume，没过期要续租或等", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  const future = new Date(Date.now() + 30 * 60_000).toISOString();
  db.prepare("UPDATE tasks SET status='doing', claimed_by='agentA', claim_expires_at=? WHERE id=?").run(future, task.id);
  assert.throws(() => taskResume(db, { id: task.id }), (e) => e.code === "E_CLAIM_ACTIVE");
  db.prepare("UPDATE tasks SET claim_expires_at=? WHERE id=?").run(new Date(Date.now() - 60_000).toISOString(), task.id);
  const res = taskResume(db, { id: task.id });
  assert.equal(res.status, "backlog");
  assert.equal(res.releasedFrom, "agentA");
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(task.id).status, "backlog");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE task_id=? AND action='task.resume'").get(task.id).c, 1);
});

test("报告里要有失败原因、返工记录和人写的那句话", () => {
  const { db, taskId } = fixture();
  taskRework(db, { id: taskId, note: "把 XXX 换成 YYY" });
  const report = reworkReport(db, taskId);
  assert.equal(report.taskId, taskId);
  assert.equal(report.attempts[0].code, "E_ASSERTION_FAILED");
  assert.equal(report.reworks.length, 1);
  assert.deepEqual(report.notes, ["把 XXX 换成 YYY"]);
  assert.equal(report.state.state, "ready", "返工后回到待办，等着被领");
});