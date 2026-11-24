// devcontrol — next 必须永远给一个「现在真能执行」的动作（P1-3 不变量）
//
// 现场（实测过）：挂起的任务属于 Agent 可修复类型时，next 返回 wait，
// 但 wait 的文案让 Agent 去 task.rework——而 task.rework 根本不在 availableActions 里。
// 「告诉 Agent 该做什么」和「Agent 现在真能做」必须永远是同一件事，否则这套内核
// 就是在教人撞墙。这条测试把四种典型状态都钉住。
import test from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "../src/digest.js";
import { ACTIONS } from "../src/mcp.js";
import { logEvent } from "../src/db.js";
import { taskClaim } from "../src/gates.js";
import { makeRepo, initFlow, newTask, prove } from "./helpers.js";

function invariant(db, root, label) {
  const d = bootstrap(db, root);
  const action = d.next?.action;
  assert.ok(ACTIONS.includes(action), `${label}：next.action=${action} 不在合法枚举里`);
  assert.ok(
    d.actions.includes(action),
    `${label}：next.action=${action} 不在 availableActions（${d.actions.join(", ")}）里——Agent 照抄会被拒`,
  );
  return d;
}

test("不变量：有缺口 → task.create，且在执行面里", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const d = invariant(db, root, "有缺口");
  assert.equal(d.next.action, "task.create");
  db.close();
});

test("不变量：挂起且属于 Agent 可修复 → 直接给 task.rework（不是 wait）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  db.prepare("UPDATE tasks SET status='parked' WHERE id=?").run(t.id);
  logEvent(db, { actor: "agent", action: "close.fail", taskId: t.id, code: "E_ASSERTION_FAILED", detail: "没过" });
  const d = invariant(db, root, "挂起(代码类)");
  assert.equal(d.next.action, "task.rework", "可自救的挂起任务要直接派回去重试");
  assert.equal(d.next.args.id, t.id);
  db.close();
});

test("不变量：在办但租约过期 → 直接给 task.resume", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");
  db.prepare("UPDATE tasks SET claim_expires_at=? WHERE id=?").run(new Date(Date.now() - 60_000).toISOString(), t.id);
  const d = invariant(db, root, "在办(租约过期)");
  assert.equal(d.next.action, "task.resume");
  assert.equal(d.next.args.id, t.id);
  db.close();
});

test("不变量：在办且租约有效 → task.work / task.close，都在执行面里", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");
  invariant(db, root, "在办");
  prove(db, root, t.id);
  const d2 = invariant(db, root, "在办+有证据");
  assert.ok(["task.work", "task.close"].includes(d2.next.action));
  db.close();
});

test("不变量：返工次数用完 → 不再派 task.rework（该交人了）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  db.prepare("UPDATE tasks SET status='parked' WHERE id=?").run(t.id);
  logEvent(db, { actor: "agent", action: "close.fail", taskId: t.id, code: "E_ASSERTION_FAILED", detail: "没过" });
  for (let i = 0; i < 3; i += 1) logEvent(db, { actor: "agent", action: "task.rework", taskId: t.id, detail: `第 ${i + 1} 次` });
  const d = invariant(db, root, "返工用完");
  assert.notEqual(d.next.action, "task.rework", "次数用完就该交人，不能再派回去");
  db.close();
});