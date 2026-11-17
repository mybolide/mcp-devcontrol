// devcontrol — 「这件事不做了」必须有出口
//
// 真实缺口：parked 只能 reopen（重试），需求也没有终态。于是两件很平常的事没有出路：
//   · 做完发现不该做
//   · 试了三次决定放弃
// 结果需求永远占着覆盖率，Agent 的 next 永远在等一个不会发生的 reopen。
// 作废是 Owner 的决定，所以只在控制台；Agent 不能自己宣布「这活不做了」。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, initFlow, newTask } from "./helpers.js";
import { openDb } from "../src/db.js";
import { reqAbandon, listTasks, listReqs } from "../src/store.js";
import { bootstrap, coverage } from "../src/digest.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import { doctor } from "../src/report.js";

const REASON = "客户改了方案，这个接口不再需要了";

async function parkTask(db, root, task) {
  taskClaim(db, root, { id: task.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 777;\n");
  commitFiles(root, ["src/a.js"], `feat: 错\n\nTask-Id: ${task.id}`, { author: "agent" });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => taskClose(db, root, { id: task.id, resolvedBy: "还在查" }));
  }
}

test("作废需求：需求归档，还挂着的任务一起放弃", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  await parkTask(db, root, task);

  const res = reqAbandon(db, root, { requirementId: reqId, reason: REASON });
  assert.equal(res.status, "archived");
  assert.deepEqual(res.archivedTasks, [task.id]);

  assert.equal(listReqs(db).find((r) => r.id === reqId).status, "archived");
  assert.equal(listTasks(db).find((t) => t.id === task.id).status, "abandoned");
});

test("作废之后，next 不再围着它转（覆盖率不再统计已归档需求）", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  await parkTask(db, root, task);

  const before = bootstrap(db, root);
  assert.equal(before.next.action, "wait", "作废前应等 Owner");

  reqAbandon(db, root, { requirementId: reqId, reason: REASON });
  const after = bootstrap(db, root);
  assert.equal(coverage(db).length, 0, "已归档需求不参与覆盖率");
  assert.notEqual(after.next.action, "task.create", "不该再让人去覆盖一条已经决定不做的验收");
  assert.equal(after.next.action, "wait");
});

test("作废要写理由，且和内核其他门槛一样至少 12 字", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  assert.throws(() => reqAbandon(db, root, { requirementId: reqId, reason: "不做了" }), (e) => e.code === "E_CONTRACT");
});

test("已经作废过的再作废一次，明确拒绝而不是静默成功", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  reqAbandon(db, root, { requirementId: reqId, reason: REASON });
  assert.throws(() => reqAbandon(db, root, { requirementId: reqId, reason: REASON }), (e) => e.code === "E_ILLEGAL_TRANSITION");
});

test("作废不存在的需求报 NOT_FOUND", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  assert.throws(() => reqAbandon(db, root, { requirementId: "FR-999", reason: REASON }), (e) => e.code === "NOT_FOUND");
});

test("放弃的任务不会再被领走", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  await parkTask(db, root, task);
  reqAbandon(db, root, { requirementId: reqId, reason: REASON });
  await assert.rejects(
    async () => taskClaim(db, root, { id: task.id }, "agent"),
    (e) => ["E_ILLEGAL_TRANSITION", "E_NEED_APPROVED", "E_PARKED", "E_CLAIMED_BY_OTHER", "E_CLAIM_STALE"].includes(e.code),
  );
});

test("作废是审计动作：事件里记下理由与连带任务", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  reqAbandon(db, root, { requirementId: reqId, reason: REASON });
  const ev = db.prepare("SELECT detail FROM events WHERE action='req.abandon' ORDER BY id DESC LIMIT 1").get();
  assert.ok(ev, "应写 req.abandon 事件");
  assert.match(ev.detail, new RegExp(task.id));
  assert.match(ev.detail, /客户改了方案/);
});

test("doctor 不把 abandoned / archived 当成异常", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  newTask(db, root, reqId);
  reqAbandon(db, root, { requirementId: reqId, reason: REASON });
  const bad = doctor(db, root).filter((i) => i.severity === "error");
  assert.deepEqual(bad.map((i) => i.code), [], "作废是正常终态，不该报错");
});