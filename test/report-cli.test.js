// devcontrol — devcontrol report：周报要能从命令行拿到
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeRepo, initFlow, BIN } from "./helpers.js";

const cli = (root, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "cli-agent" },
  });
const seed = (db, rows) => {
  const stmt = db.prepare("INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)");
  // 每条 close 对应一条独立任务：同一任务收口两次不是真实情形（T-127 按任务去重）
  let n = 0;
  for (const [at, actor, action, code] of rows) stmt.run(at, actor, "agent", action, `T-${String(++n).padStart(3, "0")}`, code ?? null, "");
};

// 相对「现在」造数据，避开各机器时钟差
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

test("report：默认看 7 天，出 markdown", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    [ago(1), "a", "task.claim"],
    [ago(2), "a", "close"],
    [ago(30), "a", "close"], // 在 7 天窗口外
  ]);

  const r = cli(root, "report");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# 周报 \d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}/);
  assert.match(r.stdout, /收口 1 条/);
  assert.match(r.stdout, /## 每天/);
});

test("report --days 30：窗外那条被算进来", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    [ago(1), "a", "close"],
    [ago(20), "a", "close"],
  ]);

  assert.match(cli(root, "report").stdout, /收口 1 条/);
  assert.match(cli(root, "report", "--days", "30").stdout, /收口 2 条/);
});

test("report --json：输出能直接 JSON.parse，口径与 markdown 一致", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    [ago(1), "a", "close"],
    [ago(2), "b", "close.fail", "E_SCOPE_VIOLATION"],
  ]);

  const r = cli(root, "report", "--json");
  assert.equal(r.status, 0, r.stderr);
  const w = JSON.parse(r.stdout);
  assert.equal(w.days, 7);
  assert.equal(w.totals.closed, 1);
  assert.equal(w.totals.blocked, 1);
  assert.deepEqual(w.topBlocked, [{ code: "E_SCOPE_VIOLATION", count: 1 }]);
  assert.match(cli(root, "report").stdout, /收口 1 条/);
});

test("report --days 不合法：退出码 2 + 失败契约，不吐半张空表", () => {
  const root = makeRepo();
  initFlow(root);
  for (const bad of ["0", "-3", "abc"]) {
    const r = cli(root, "report", "--days", bad);
    assert.equal(r.status, 2, `--days ${bad} 应该退出码 2`);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "E_USAGE");
    assert.ok(payload.hint, "错误码必须带 hint");
  }
});

test("report：空仓库也能出，说「这一周没有动工记录」而不是崩", () => {
  const root = makeRepo();
  initFlow(root);
  const r = cli(root, "report");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /这一周没有动工记录/);
});

test("report --title：标题可换", () => {
  const root = makeRepo();
  initFlow(root);
  const r = cli(root, "report", "--title", "研发周报");
  assert.match(r.stdout, /^# 研发周报 /);
});

test("help 里有 report：不然用户根本不知道有这个命令", () => {
  const root = makeRepo();
  initFlow(root);
  const r = cli(root, "help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /devcontrol report \[--days 7\] \[--json\]/);
});