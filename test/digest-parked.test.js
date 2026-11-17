// devcontrol — parked 任务不能被「建新任务」顶替
//
// 真实事故：一条任务连续失败 3 次被自动 parked，随后 devcontrol next 说
//   「需求 FR-001 还有 1 条验收没有任务覆盖：npm test :: exit==0」→ 去 task.create
// 照做就会建出第二条覆盖同一验收的任务，而第一条还在等 Owner 决定。
// 更难受的是 status.blockers 同时写着「T-001 已 parked，等 Owner reopen」——
// 两个面给出相反的建议，Agent 按 next 走（SKILL 说 next 就是下一件事）。
//
// 根因：coverage() 把 parked 当成「没覆盖」。parked 不是「没做」，是「卡住了」。
import test from "node:test";
import assert from "node:assert/strict";
import { makeRepo, initFlow, newTask } from "./helpers.js";
import { openDb } from "../src/db.js";
import { bootstrap, coverage } from "../src/digest.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import fs from "node:fs";
import path from "node:path";

/** 把一个任务做到 parked：连续失败 3 次（验收命令必然失败） */
async function parkTask(db, root, task) {
  taskClaim(db, root, { id: task.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 999;\n");
  commitFiles(root, ["src/a.js"], `feat: 错\n\nTask-Id: ${task.id}`, { author: "agent" });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => taskClose(db, root, { id: task.id, resolvedBy: "还在查" }));
  }
  return db.prepare("SELECT status FROM tasks WHERE id=?").get(task.id).status;
}

test("parked 的任务仍然算「这条验收有人管」", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  assert.equal(await parkTask(db, root, task), "parked");

  const plan = coverage(db).find((p) => p.id === reqId);
  assert.deepEqual(plan.missing, [], "parked 不该算成「验收没人管」");
  assert.equal(plan.covered, 1);
});

test("next 不会让人建新任务顶替 parked（而是等 Owner）", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  await parkTask(db, root, task);

  const digest = bootstrap(db, root);
  assert.equal(digest.next.action, "wait", `不该建议 ${digest.next.action}`);
  assert.match(digest.next.why, new RegExp(task.id));
  assert.match(digest.next.why, /parked/);
  assert.match(digest.next.why, /不要新建任务/, "要说清「不要另起一条」，否则 Agent 还是会去建");
});

test("next 与 blockers 不再互相打脸", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  await parkTask(db, root, task);

  const digest = bootstrap(db, root);
  const parkedBlocker = digest.blockers.find((b) => b.code === "E_PARKED");
  assert.ok(parkedBlocker, "blockers 应报 E_PARKED");
  // 两边的说法必须一致：都说「等 Owner」
  assert.equal(digest.next.action, "wait");
  assert.match(parkedBlocker.fix, /Owner/);
});

test("还有 backlog 任务可领时，先去干能干的活（别傻等）", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const parked = newTask(db, root, reqId, { title: "会失败的那条" });
  await parkTask(db, root, parked);
  const other = newTask(db, root, reqId, { title: "能干的活" });

  const digest = bootstrap(db, root);
  assert.equal(digest.next.action, "task.claim");
  assert.equal(digest.next.args.id, other.id);
});

test("Owner reopen 之后，任务回到可领取，next 也随之恢复", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  await parkTask(db, root, task);

  const { taskReopen } = await import("../src/store.js");
  taskReopen(db, { taskId: task.id });
  const digest = bootstrap(db, root);
  assert.equal(digest.next.action, "task.claim");
  assert.equal(digest.next.args.id, task.id);
});
test("领 parked 任务报 E_PARKED，不能谎称「被他人领取」", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  await parkTask(db, root, task);

  // 报错方向错了，Agent 会去等一个不存在的人
  await assert.rejects(
    async () => taskClaim(db, root, { id: task.id }, "someone-else"),
    (e) => e.code === "E_PARKED" && /Owner/.test(e.message),
  );
});

test("parked 时把 claim 状态清干净（它不是「还攥在手里」）", async () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  await parkTask(db, root, task);
  const row = db.prepare("SELECT status,claimed_by,claim_expires_at FROM tasks WHERE id=?").get(task.id);
  assert.equal(row.status, "parked");
  assert.equal(row.claimed_by, null, "parked 不该还留着领取人");
  assert.equal(row.claim_expires_at, null);
});

test("真被别人领走时报 E_CLAIMED_BY_OTHER，并说清是谁、到什么时候", async () => {
  const root = makeRepo({ failTest: false });
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agent-a");
  await assert.rejects(
    async () => taskClaim(db, root, { id: task.id }, "agent-b"),
    (e) => e.code === "E_CLAIMED_BY_OTHER" && /agent-a/.test(e.message),
  );
});
