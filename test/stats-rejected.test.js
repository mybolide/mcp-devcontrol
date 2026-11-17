// devcontrol — 「被拦」这个数必须是真的
//
// 产品把它当成「内核到底有没有在起作用」的唯一指标，而早先它只数 close.fail：
// claim / commit / create 阶段的拒绝一条都不进库，指标恒为 0，等于自证无效。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { disciplineStats } from "../src/store.js";
import { weekly } from "../src/weekly.js";
import { makeRepo, initFlow, newTask, BIN } from "./helpers.js";

const cli = (root, actor, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: actor },
  });

const rejections = (db) =>
  db.prepare("SELECT actor, code, detail FROM events WHERE action='rejected' ORDER BY id").all();

test("CLI 被拒一次，就进事件流一次（不再石沉大海）", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  assert.equal(disciplineStats(db).blocked, 0);

  const r = cli(root, "agent-x", "commit", "-m", "没领任务就想提交");
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).code, "E_NO_TASK");

  const rows = rejections(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "E_NO_TASK");
  assert.equal(rows[0].actor, "agent-x", "谁被拦的也要记下来");

  assert.equal(disciplineStats(db).blocked, 1, "「被拦」必须涨");
});

test("补一步就好的拒绝单独计数，不混进纪律数", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const { taskClaim } = await import("../src/gates.js");
  const t = newTask(db, root, reqId, { scope: ["src"] });
  taskClaim(db, root, { id: t.id }, "agent-y");

  // scope 内没有可提交的改动 → E_NO_DELIVERY，属于 env-only
  const r = cli(root, "agent-y", "commit", "-m", "空提交");
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).code, "E_NO_DELIVERY");

  const s = disciplineStats(db);
  assert.equal(s.envOnly, 1, "env-only 的记在单独的数里");
  assert.equal(s.blocked, 0, "它不该污染「被拦」");
});

test("三次不同阶段的拒绝累加，stats 和 weekly 都看得到", () => {
  const root = makeRepo();
  const { db } = initFlow(root);

  cli(root, "a", "commit", "-m", "x"); // E_NO_TASK
  cli(root, "a", "task", "claim", "T-999"); // NOT_FOUND
  cli(root, "a", "close", "T-999"); // 还是 NOT_FOUND

  const s = disciplineStats(db);
  assert.equal(s.blocked, 3, "三个阶段各算一次");

  const w = weekly(db, { days: 7 });
  assert.equal(w.totals.blocked, 3, "周报的口径要跟 stats 一致");
  assert.ok(w.topBlocked.some((b) => b.code === "NOT_FOUND"), "拦在哪要看得出来");
});

test("还没有项目库时，失败也不会凭空造一个 state.db", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noinit-"));
  // commit 缺 -m 会在 openDb 之前就失败——刚好用来验「记账不产生副作用」
  const r = spawnSync(process.execPath, [BIN, "commit"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: dir },
  });
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(dir, ".devcontrol", "state.db")), false, "记账不能有副作用");
});