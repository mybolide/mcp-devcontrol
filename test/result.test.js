// devcontrol — 需求级结果汇总（P2）
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { taskClaim } from "../src/gates.js";
import { requirementResult } from "../src/result.js";
import { makeRepo, initFlow, newTask, closeProven } from "./helpers.js";

test("结果汇总：验收覆盖、任务、证据、遗留、待 Owner 事项一次拿全", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");
  // 交付模式=verify：这条测试只关心汇总，不关心提交归属
  db.prepare("UPDATE tasks SET delivery='verify' WHERE id=?").run(t.id);
  await closeProven(db, root, { id: t.id });

  const r = requirementResult(db, reqId);
  assert.equal(r.requirementId, reqId);
  assert.equal(r.acceptanceTotal, 1);
  assert.equal(r.acceptanceDone, 1, "验收要算成已完成");
  assert.equal(r.acceptance[0].coveredBy[0], t.id);
  assert.deepEqual(r.openTasks, []);
  assert.match(r.conclusion, /已完成/);
  assert.ok(r.evidence.length >= 1, "证据要带出来");
  assert.deepEqual(r.commits, [], "verify 交付本来就没有提交，汇总要如实反映");
  assert.ok(r.tasks.every((x) => x.status === "done"));
  db.close();
});

test("结果汇总：还有没收口任务时结论是未完成，且列出待办", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  const r = requirementResult(db, reqId);
  assert.match(r.conclusion, /未完成/);
  assert.deepEqual(r.openTasks, [t.id]);
  assert.equal(r.acceptanceDone, 0);
  db.close();
});

test("结果汇总：需求不存在返回 null（不编一份空报告）", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  assert.equal(requirementResult(db, "FR-999"), null);
  db.close();
});