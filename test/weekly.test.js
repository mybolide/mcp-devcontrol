// devcontrol — 周报统计层：口径对不对，全看这几条
import test from "node:test";
import assert from "node:assert/strict";
import { weekly, verdict } from "../src/weekly.js";
import { makeRepo, initFlow } from "./helpers.js";

const NOW = new Date("2026-03-10T12:00:00.000Z");

function seedEvents(db, rows) {
  const stmt = db.prepare(
    "INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)",
  );
  for (const [at, actor, action, code] of rows) {
    stmt.run(at, actor, "agent", action, "T-001", code ?? null, "");
  }
}

test("weekly：按天/按人/按拦截码归拢事件", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seedEvents(db, [
    ["2026-03-04T09:00:00.000Z", "a", "task.create"],
    ["2026-03-04T10:00:00.000Z", "a", "task.claim"],
    ["2026-03-05T10:00:00.000Z", "b", "task.claim"],
    ["2026-03-05T11:00:00.000Z", "a", "close.fail", "E_SCOPE_VIOLATION"],
    ["2026-03-06T11:00:00.000Z", "a", "close"],
    ["2026-03-06T12:00:00.000Z", "b", "close"],
    ["2026-03-07T12:00:00.000Z", "a", "override"],
  ]);

  const w = weekly(db, { days: 7, now: NOW });

  assert.equal(w.since, "2026-03-03T12:00:00.000Z");
  assert.equal(w.until, "2026-03-10T12:00:00.000Z");
  assert.deepEqual(
    { created: w.totals.created, claimed: w.totals.claimed, closed: w.totals.closed },
    { created: 1, claimed: 2, closed: 2 },
  );
  assert.equal(w.totals.blocked, 1);
  assert.equal(w.totals.overridden, 1);
  assert.equal(w.totals.reworks, 0, "只有事件、没有跑挂过的证据：返工就是 0，不能拿被拦次数充数");

  assert.deepEqual(
    w.byDay.map((d) => [d.day, d.created, d.claimed, d.closed, d.blocked, d.overridden]),
    [
      ["2026-03-04", 1, 1, 0, 0, 0],
      ["2026-03-05", 0, 1, 0, 1, 0],
      ["2026-03-06", 0, 0, 2, 0, 0],
      ["2026-03-07", 0, 0, 0, 0, 1],
    ],
  );

  assert.deepEqual(
    w.byActor.map((a) => [a.actor, a.closed, a.claimed, a.blocked]),
    [
      ["a", 1, 1, 1],
      ["b", 1, 1, 0],
    ],
  );
  assert.deepEqual(w.topBlocked, [{ code: "E_SCOPE_VIOLATION", count: 1 }]);
});

test("weekly：窗口外的事件不算数（前后各一条）", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seedEvents(db, [
    ["2026-03-02T12:00:00.000Z", "a", "close"], // 早于 since
    ["2026-03-05T12:00:00.000Z", "a", "close"], // 窗口内
    ["2026-03-11T12:00:00.000Z", "a", "close"], // 晚于 until
  ]);

  const w = weekly(db, { days: 7, now: NOW });
  assert.equal(w.totals.closed, 1);
  assert.equal(w.byDay.length, 1);
});

test("weekly：规模从 tasks 表的 closed_at 取，和事件数各算各的", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const ins = db.prepare(
    "INSERT INTO tasks(id, requirement_id, path_id, kind, title, status, scope_json, acceptance_json, depends_on_json, budget_lines, changed_lines, base_head, contract_hash, contract_commit, created_at, updated_at, closed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const addTask = (id, lines, closedAt) =>
    ins.run(id, "R-1", "P-001", "feature", "t", "done", "[]", "[]", "[]", 100, lines, "", "", "", "2026-03-04T00:00:00.000Z", "2026-03-04T00:00:00.000Z", closedAt);
  addTask("T-001", 30, "2026-03-05T00:00:00.000Z");
  addTask("T-002", 12, "2026-03-06T00:00:00.000Z");
  addTask("T-003", 99, "2026-02-01T00:00:00.000Z");
  const w = weekly(db, { days: 7, now: NOW });
  assert.equal(w.totals.tasks, 2, "窗口外收口的不算");
  assert.equal(w.totals.lines, 42);
  assert.equal(w.totals.closed, 0, "没事件就是没事件，不拿任务表凑数");
});

test("weekly：topBlocked 只留前 5，按次数降序", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const rows = [];
  for (let i = 0; i < 7; i += 1) {
    rows.push(["2026-03-05T00:00:00.000Z", "a", "close.fail", `CODE_${String(i).padStart(2, "0")}`]);
  }
  // 让 CODE_05 出现三次，成为第一
  rows.push(["2026-03-05T00:00:00.000Z", "a", "close.fail", "CODE_05"]);
  rows.push(["2026-03-05T00:00:00.000Z", "a", "close.fail", "CODE_05"]);
  seedEvents(db, rows);

  const w = weekly(db, { days: 7, now: NOW });
  assert.equal(w.topBlocked.length, 5);
  assert.deepEqual(w.topBlocked[0], { code: "CODE_05", count: 3 });
  assert.equal(w.totals.blocked, 9);
});

test("weekly：天数为 0 或负，报 E_INVALID 而不是算出个空周", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  for (const days of [0, -1, Number.NaN]) {
    assert.throws(
      () => weekly(db, { days, now: NOW }),
      (e) => e.code === "E_INVALID",
      `days=${days} 应该被拒`,
    );
  }
});

test("verdict：没动工 / 正常一周，各说各的话", () => {
  const empty = verdict({ totals: { created: 0, claimed: 0, closed: 0, blocked: 0, overridden: 0, lines: 0 } });
  assert.equal(empty, "这一周没有动工记录");

  const line = verdict({
    totals: { created: 3, claimed: 4, closed: 2, blocked: 1, overridden: 1, lines: 150 },
  });
  assert.match(line, /收口 2 条/);
  assert.match(line, /成率 50%/);
  assert.match(line, /被拦 1 次/);
  assert.match(line, /Owner 放行 1 次/);
  assert.match(line, /净改动 150 行/);
});

test("verdict：只建任务没领活时，成率是 0 不是 NaN", () => {
  const line = verdict({ totals: { created: 2, claimed: 0, closed: 0, blocked: 0, overridden: 0, lines: 0 } });
  assert.match(line, /成率 0%/);
  assert.doesNotMatch(line, /NaN/);
});
