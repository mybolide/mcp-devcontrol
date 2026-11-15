// devcontrol — 租约续期：task.renew + 写操作自动续租（契约 §5.1）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../src/db.js";
import { getTask } from "../src/store.js";
import { taskClaim, taskRenew } from "../src/gates.js";
import { availableActions } from "../src/digest.js";
import { cmdCommit } from "../src/cli.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";

const code = (c) => (e) => e.code === c;

function claimed(root, actor = "agentA") {
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, actor);
  return { db, task };
}

// 把租期改到一个确定的时刻，方便断言「确实往后推了」
function pinExpiry(db, id, iso) {
  db.prepare("UPDATE tasks SET claim_expires_at=? WHERE id=?").run(iso, id);
  return iso;
}

test("task.renew 把租期往后推，并落一条事件", () => {
  const root = makeRepo();
  const { db, task } = claimed(root);
  const before = pinExpiry(db, task.id, new Date(Date.now() + 60_000).toISOString());

  const res = taskRenew(db, root, { id: task.id }, "agentA");
  assert.equal(res.ok, true);
  assert.equal(res.id, task.id);
  assert.ok(res.claimExpiresAt > before, `${res.claimExpiresAt} 应晚于 ${before}`);
  assert.equal(getTask(db, task.id).claim_expires_at, res.claimExpiresAt);
  assert.ok(db.prepare("SELECT 1 FROM events WHERE action='task.renew' AND task_id=?").get(task.id), "续租要留痕");
});

test("租期已过再 renew → E_CLAIM_STALE（必须重新 claim）", () => {
  const root = makeRepo();
  const { db, task } = claimed(root);
  pinExpiry(db, task.id, new Date(Date.now() - 60_000).toISOString());
  assert.throws(() => taskRenew(db, root, { id: task.id }, "agentA"), code("E_CLAIM_STALE"));
});

test("续别人手上的任务 → E_CLAIMED_BY_OTHER", () => {
  const root = makeRepo();
  const { db, task } = claimed(root, "agentA");
  assert.throws(() => taskRenew(db, root, { id: task.id }, "agentB"), code("E_CLAIMED_BY_OTHER"));
});

test("没在办的任务 renew → E_CLAIM_STALE，不复用别人的租约", () => {
  const root = makeRepo();
  const { db, task } = claimed(root);
  db.prepare("UPDATE tasks SET status='backlog', claimed_by=NULL, claim_expires_at=NULL WHERE id=?").run(task.id);
  assert.throws(() => taskRenew(db, root, { id: task.id }, "agentA"), code("E_CLAIM_STALE"));
});

test("doing 时 actions 里有 task.renew（否则 Agent 无从知道可以续）", () => {
  const root = makeRepo();
  const { db } = claimed(root);
  const acts = availableActions(db);
  assert.ok(acts.includes("task.renew"), JSON.stringify(acts));
  assert.ok(acts.includes("task.close"));
});

test("devcontrol commit 这类写操作自动续租", () => {
  const root = makeRepo();
  const { db, task } = claimed(root);
  const before = pinExpiry(db, task.id, new Date(Date.now() + 60_000).toISOString());
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");

  const prev = process.env.DEVCONTROL_ROOT;
  process.env.DEVCONTROL_ROOT = root;
  let rc;
  try {
    rc = cmdCommit(["-m", "feat: 改 a", "--actor", "agentA"]);
  } finally {
    if (prev === undefined) delete process.env.DEVCONTROL_ROOT;
    else process.env.DEVCONTROL_ROOT = prev;
  }
  assert.equal(rc, 0);
  const after = getTask(openDb(root), task.id).claim_expires_at;
  assert.ok(after > before, `commit 后租期应续到 ${before} 之后，实际 ${after}`);
});
