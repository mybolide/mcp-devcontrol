// devcontrol — ask 的三类问题（P1-4）
//
// 只有 C 类该占 Owner 的待办：超范围、新权限、不可逆数据操作、产品方向、真金白银。
// 技术选型（A）归 Agent 自己；依赖没装/服务挂了（B）先自己重试降级等待。
// 以前不分青红皂白一律挂起任务 + 建一条待办，Owner 一开控制台就是一堆「选哪个实现」。
import test from "node:test";
import assert from "node:assert/strict";
import { ask, taskClaim } from "../src/gates.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";

function doing() {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");
  return { root, db, task };
}

test("A 类（技术选型）直接拒：这是你自己的判断，别占 Owner 待办", () => {
  const { db, task } = doing();
  assert.throws(
    () => ask(db, { taskId: task.id, question: "用 JSON 还是 MessagePack？", kind: "decision" }),
    (e) => e.code === "E_ASK_NOT_OWNER",
  );
  assert.equal(db.prepare("SELECT COUNT(*) c FROM questions").get().c, 0, "不许留下问题");
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(task.id).status, "doing", "任务不该被挂起");
  db.close();
});

test("B 类（外部阻塞）只记事件：任务继续，Agent 自己重试/降级/等待", () => {
  const { db, task } = doing();
  const res = ask(db, { taskId: task.id, question: "npm registry 502", kind: "external" });
  assert.equal(res.kind, "external");
  assert.equal(res.questionId, null);
  assert.match(res.guidance, /重试/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM questions").get().c, 0);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(task.id).status, "doing");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events WHERE action='ask.external' AND task_id=?").get(task.id).c, 1);
  db.close();
});

test("C 类（真要人定）照旧：建问题 + 挂起任务", () => {
  const { db, task } = doing();
  const res = ask(db, { taskId: task.id, question: "要不要把旧接口删掉？不可逆", kind: "owner" });
  assert.equal(res.kind, "owner");
  assert.match(res.questionId, /^Q-\d+$/);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(task.id).status, "parked");
  db.close();
});

test("不给 kind 时沿用老行为（owner），别名也认", () => {
  const a = doing();
  assert.equal(ask(a.db, { taskId: a.task.id, question: "要不要动线上数据？" }).kind, "owner");
  a.db.close();
  const b = doing();
  assert.equal(ask(b.db, { taskId: b.task.id, question: "权限给谁？", kind: "c" }).kind, "owner");
  b.db.close();
});

test("乱写 kind 明确报错，不悄悄当成 owner", () => {
  const { db, task } = doing();
  assert.throws(() => ask(db, { taskId: task.id, question: "x", kind: "whatever" }), (e) => e.code === "INVALID_ARGUMENT");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM questions").get().c, 0);
  db.close();
});