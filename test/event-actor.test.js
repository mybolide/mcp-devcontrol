// devcontrol — 事件流的 actor 必须是真干活的那个人
// 事故：10 种事件全记成 system，于是「谁做了什么」问不出来，周报的「按人」一栏只能显示 system（T-088）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { taskCreate, taskClaim } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import { openDb } from "../src/db.js";
import { makeRepo, initFlow, newTask, prove, closeProven, BIN } from "./helpers.js";

const actorsOf = (db, action) =>
  db.prepare("SELECT actor FROM events WHERE action=? ORDER BY id").all(action).map((r) => r.actor);

const mkTask = (db, root, reqId, actor, title = "改 a.js", scope = ["src"]) =>
  taskCreate(
    db,
    root,
    {
      requirementId: reqId,
      pathId: "P-001",
      kind: "feature",
      title,
      acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
      scope,
    },
    actor,
  );

/** 造一次带 Task-Id 的提交：收口要求「区间内有本任务的提交」 */
const land = (root, rel, id, author) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `// ${id}\n`);
  return commitFiles(root, [rel], `feat: ${id}\n\nTask-Id: ${id}`, { author });
};

test("task.create 记的是建任务的人，不是 system", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  mkTask(db, root, reqId, "agent-a");
  assert.deepEqual(actorsOf(db, "task.create"), ["agent-a"]);
});

test("task.claim / run.evidence / close 三段全落在干活的人名下", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = mkTask(db, root, reqId, "agent-a", "改 a.js", ["src/a.js"]);

  taskClaim(db, root, { id: t.id }, "agent-b");
  land(root, "src/a.js", t.id, "agent-b");
  await closeProven(db, root, { id: t.id });

  assert.deepEqual(actorsOf(db, "task.claim"), ["agent-b"]);
  assert.deepEqual(actorsOf(db, "run.evidence"), ["agent-b"], "证据是谁跑的记谁");
  assert.deepEqual(actorsOf(db, "close"), ["agent-b"], "收口记领取者");
});

test("收口失败时 close.fail 也记领取者", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = mkTask(db, root, reqId, "agent-a", "改 a.js", ["src/a.js"]);
  taskClaim(db, root, { id: t.id }, "agent-c");

  land(root, "src/a.js", t.id, "agent-c");
  await assert.rejects(() => closeProven(db, root, { id: t.id }, { exit: 1 }), (e) => e.code === "E_ASSERTION_FAILED");

  assert.deepEqual(actorsOf(db, "close.fail"), ["agent-c"]);
});

test("两个 Agent 并行干活，事件按人分得开（周报「按人」的前提）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const a = mkTask(db, root, reqId, "agent-a", "任务 A", ["src/a.js"]);
  const b = mkTask(db, root, reqId, "agent-b", "任务 B", ["src/b.js"]);

  taskClaim(db, root, { id: a.id }, "agent-a");
  taskClaim(db, root, { id: b.id }, "agent-b");
  land(root, "src/a.js", a.id, "agent-a");
  land(root, "src/b.js", b.id, "agent-b");
  await closeProven(db, root, { id: a.id });
  await closeProven(db, root, { id: b.id });

  const closes = db.prepare("SELECT actor, task_id FROM events WHERE action='close' ORDER BY id").all();
  assert.deepEqual(
    closes.map((r) => [r.actor, r.task_id]),
    [
      ["agent-a", a.id],
      ["agent-b", b.id],
    ],
  );
});

test("CLI：DEVCONTROL_ACTOR 一路传到事件里", () => {
  const root = makeRepo();
  initFlow(root);
  const r = spawnSync(
    process.execPath,
    [BIN, "task", "create", "--req", "FR-001", "--path", "P-001", "--title", "命令行建的", "--scope", "src"],
    { cwd: root, encoding: "utf8", env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "cli-agent" } },
  );
  assert.equal(r.status, 0, r.stderr);

  const db = openDb(root);
  assert.deepEqual(actorsOf(db, "task.create"), ["cli-agent"]);
  db.close();
});

test("这五类事件不该再记成 system", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/a.js"] });
  taskClaim(db, root, { id: t.id }, "agent-x");
  land(root, "src/a.js", t.id, "agent-x");
  await closeProven(db, root, { id: t.id });

  const sys = db
    .prepare("SELECT action FROM events WHERE actor='system' AND action IN ('task.create','task.claim','close','close.fail','run.evidence')")
    .all();
  assert.deepEqual(sys, [], `这些事件不该再记成 system：${JSON.stringify(sys)}`);
});
