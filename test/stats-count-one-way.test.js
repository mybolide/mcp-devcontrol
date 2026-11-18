// 「已完成」只能有一个口径。
//
// 起因是真实踩坑：stats 说「已完成 119 个任务」，同一时刻周报说「收口 116 条」。
// 差的 3 条全是 Owner 用 override --mode force-close 放行收口的任务——
// 它们在事件流里只有 override，没有 close，于是周报只数 close 事件就漏掉了。
// 同一个词两个数，读者没法判断该信谁，这正是 T-119 要根除的那类问题。
import test from "node:test";
import assert from "node:assert/strict";
import { weekly, verdict } from "../src/weekly.js";
import { disciplineStats } from "../src/store.js";
import { makeRepo, initFlow } from "./helpers.js";

const NOW = new Date("2026-03-10T12:00:00.000Z");

/** 造一条任务，直接置成 done（绕过门禁，只为造出「事实」）。 */
function doneTask(db, id, { closedAt, closedBy }) {
  db.prepare(
    `INSERT INTO tasks(id, requirement_id, path_id, kind, title, status, scope_json, acceptance_json,
       depends_on_json, budget_lines, changed_lines, base_head, contract_hash, contract_commit,
       created_at, updated_at, closed_at, closed_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, "FR-1", "P-001", "feature", "t", "done", "[]", "[]", "[]",
    100, 10, "", "", "", "2026-03-04T00:00:00.000Z", "2026-03-04T00:00:00.000Z", closedAt, closedBy,
  );
}

function addEvent(db, { at, actor = "agent", action, taskId = "T-001", code = null }) {
  db.prepare(
    "INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)",
  ).run(at, actor, "agent", action, taskId, code, "");
}

test("Owner 放行收口的任务也算进周报「收口」：stats 与周报不再各说各话", () => {
  const root = makeRepo();
  const { db } = initFlow(root);

  // 两条正常收口（有 close 事件）
  for (const id of ["T-001", "T-002"]) {
    doneTask(db, id, { closedAt: "2026-03-05T10:00:00.000Z", closedBy: "evidence" });
    addEvent(db, { at: "2026-03-05T10:00:00.000Z", action: "close", taskId: id });
  }
  // 一条 Owner 放行收口（只有 override，没有 close）
  doneTask(db, "T-003", { closedAt: "2026-03-06T10:00:00.000Z", closedBy: "force-close" });
  addEvent(db, { at: "2026-03-06T10:00:00.000Z", actor: "owner", action: "override", taskId: "T-003", code: "E_SCOPE_VIOLATION" });

  const w = weekly(db, { days: 30, now: NOW });
  const s = disciplineStats(db);

  assert.equal(s.done, 3, "三条任务都是 done");
  assert.equal(w.totals.closed, 3, `周报也要说 3 条，实际 ${w.totals.closed}`);
  assert.equal(w.totals.closed, s.done, "两个数必须相等：这就是这条测试的全部意义");
});

test("放行收口的按天/按人归因也对得上：每天加起来等于总数", () => {
  const root = makeRepo();
  const { db } = initFlow(root);

  addEvent(db, { at: "2026-03-05T10:00:00.000Z", action: "close", taskId: "T-001" });
  doneTask(db, "T-001", { closedAt: "2026-03-05T10:00:00.000Z", closedBy: "evidence" });
  doneTask(db, "T-002", { closedAt: "2026-03-06T10:00:00.000Z", closedBy: "force-close" });
  addEvent(db, { at: "2026-03-06T10:00:00.000Z", actor: "owner", action: "override", taskId: "T-002", code: "E_INTERNAL" });

  const w = weekly(db, { days: 30, now: NOW });

  const byDaySum = w.byDay.reduce((n, d) => n + d.closed, 0);
  const byActorSum = w.byActor.reduce((n, a) => n + a.closed, 0);
  assert.equal(w.totals.closed, 2);
  assert.equal(byDaySum, w.totals.closed, "「每天」那张表加起来必须等于总数");
  assert.equal(byActorSum, w.totals.closed, "「按人」那张表加起来必须等于总数");

  // 放行收口的账记在 Owner 名下，不能算成某个 Agent 自己收的工
  const owner = w.byActor.find((a) => a.actor === "owner");
  assert.equal(owner?.closed, 1, "force-close 的收口记在 owner 名下");
});

test("没有 close 事件、也不是 force-close 的任务，不拿来凑收口数", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  // closed_by 是空的：既没 close 事件、也不是放行收口，属于账不清的情况。
  // 这种不该被悄悄算进「收口」，否则等于用任务表给事件流补窟窿。
  doneTask(db, "T-001", { closedAt: "2026-03-05T10:00:00.000Z", closedBy: null });

  const w = weekly(db, { days: 30, now: NOW });
  assert.equal(w.totals.closed, 0, "没凭据就不算收口");
  assert.equal(w.totals.tasks, 1, "但任务规模照实说");
});

test("为 0 时不能说成「收口 0 条」以外的怪话", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const w = weekly(db, { days: 7, now: NOW });
  assert.equal(w.totals.closed, 0);
  assert.equal(verdict(w), "这一周没有动工记录");
});
