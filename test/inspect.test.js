// devcontrol — 查询能力（P2-7）：状态 / 验收结果 / 失败原因 / 待决策
import test from "node:test";
import assert from "node:assert/strict";
import { logEvent } from "../src/db.js";
import { taskClaim, ask } from "../src/gates.js";
import { taskStatus, acceptanceStatus, failureStatus, decisions } from "../src/inspect.js";
import { makeRepo, initFlow, newTask, prove } from "./helpers.js";

test("状态查询：一次拿到状态、证据、失败与返工历史", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  prove(db, root, task.id, { exit: 1 });
  logEvent(db, { actor: "agent", action: "close.fail", taskId: task.id, code: "E_ASSERTION_FAILED", detail: "第 1 次" });
  db.prepare("UPDATE tasks SET status='parked' WHERE id=?").run(task.id);

  const st = taskStatus(db, task.id);
  assert.equal(st.status, "parked");
  assert.equal(st.requirementId, reqId);
  assert.equal(st.runs.length, 1, "证据要能看到");
  assert.equal(st.failures[0].code, "E_ASSERTION_FAILED");
  assert.equal(st.state.state, "needs_rework", "代码类失败 → Agent 自己能救");
  assert.equal(st.state.owner, "agent");

  const acc = acceptanceStatus(db, task.id);
  assert.equal(acc.items.length, 1);
  assert.equal(acc.items[0].passed, false);
  assert.ok(acc.items[0].runId, "要能指回是哪条证据");

  const fail = failureStatus(db, task.id);
  assert.equal(fail.owner, "agent");
  assert.equal(fail.attempts.length, 1);

  assert.deepEqual(decisions(db), [], "能自救的不进待决策清单");
  db.close();
});

test("待决策清单：授权类挂起与待回答的问题才上榜", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const a = newTask(db, root, reqId, { title: "授权卡住" });
  db.prepare("UPDATE tasks SET status='parked' WHERE id=?").run(a.id);
  logEvent(db, { actor: "agent", action: "close.fail", taskId: a.id, code: "E_NEED_APPROVED", detail: "没批" });

  const b = newTask(db, root, reqId, { title: "要人拍板" });
  taskClaim(db, root, { id: b.id }, "agentA");
  ask(db, { taskId: b.id, question: "要不要删旧接口？", kind: "owner" });

  const list = decisions(db);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((x) => x.kind).sort(), ["needs-owner", "question"]);
  db.close();
});