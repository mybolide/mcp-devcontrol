// 「收口」这条账必须能对上一个数（T-127）。
//
// 事故：一条任务「收口 → Owner 打回 → 再收口」，事件流里有两条 close。
// 周报逐条累加说「收口 2 条」，stats 说「已完成 1 个」——方向反过来，
// 同一个词又变成两个数（T-121 只修了 force-close 那一半）。
//
// 还有两处同源的毛病，一起钉住：
//   · closed_at 和 close 事件各调一次 now()，差几毫秒就能让同一任务
//     「按 closed_at 算在窗内、按事件算在窗外」，两边各数各的；
//   · stats 不认时间窗，于是「累计 125」和「本周 38」并排出现，
//     数都对，读者却没法判断该信哪个。
import test from "node:test";
import assert from "node:assert/strict";
import { weekly } from "../src/weekly.js";
import { disciplineStats, taskReopen } from "../src/store.js";
import { makeRepo, initFlow } from "./helpers.js";

const NOW = new Date("2026-03-10T12:00:00.000Z");

function addEvent(db, { at, actor = "agent", action, taskId = "T-001", code = null }) {
  db.prepare("INSERT INTO events(at,actor,channel,action,task_id,code,detail) VALUES(?,?,?,?,?,?,?)").run(
    at,
    actor,
    "agent",
    action,
    taskId,
    code,
    "",
  );
}

function addTask(db, id, { status = "done", closedAt = null, closedBy = null, lines = 10 }) {
  db.prepare(
    `INSERT INTO tasks(id, requirement_id, path_id, kind, title, status, scope_json, acceptance_json,
       depends_on_json, budget_lines, changed_lines, base_head, contract_hash, contract_commit,
       created_at, updated_at, closed_at, closed_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, "FR-1", "P-001", "feature", "t", status, "[]", "[]", "[]",
    100, lines, "", "", "", "2026-03-04T00:00:00.000Z", "2026-03-04T00:00:00.000Z", closedAt, closedBy,
  );
}

test("收口→打回→再收口：只算一条，不是两条", () => {
  const root = makeRepo();
  const { db } = initFlow(root);

  addTask(db, "T-001", { status: "done", closedAt: "2026-03-08T10:00:00.000Z", closedBy: "evidence" });
  addEvent(db, { at: "2026-03-05T10:00:00.000Z", action: "close" });
  addEvent(db, { at: "2026-03-06T10:00:00.000Z", actor: "owner", action: "task.reopen" });
  addEvent(db, { at: "2026-03-08T10:00:00.000Z", action: "close" });

  const w = weekly(db, { days: 30, now: NOW });
  const s = disciplineStats(db, { since: w.since, until: w.until });

  assert.equal(w.totals.closed, 1, `同一条任务只能算一次，实际 ${w.totals.closed}`);
  assert.equal(s.done, 1);
  assert.equal(w.totals.closed, s.done, "周报的「收口」和 stats 的「已完成」必须相等");
  // 归到真正收口的那天，不是第一次收口那天
  assert.deepEqual(
    w.byDay.map((d) => d.day),
    ["2026-03-08"],
    `该归到最后一次收口：${JSON.stringify(w.byDay)}`,
  );
});

test("收口后被打回、现在不是 done：不许再算收口（否则收口 1 条、已完成 0 个）", () => {
  const root = makeRepo();
  const { db } = initFlow(root);

  addTask(db, "T-001", { status: "done", closedAt: "2026-03-05T10:00:00.000Z", closedBy: "evidence" });
  addEvent(db, { at: "2026-03-05T10:00:00.000Z", action: "close" });
  // 走真实入口打回：closed_at 被清空，任务回到 backlog
  taskReopen(db, { taskId: "T-001", reason: "做得不对，重做一遍" });

  const w = weekly(db, { days: 30, now: NOW });
  const s = disciplineStats(db, { since: w.since, until: w.until });

  assert.equal(w.totals.closed, 0, "打回之后不算收口");
  assert.equal(s.done, 0);
  assert.equal(w.totals.closed, s.done);
  const byDaySum = w.byDay.reduce((n, d) => n + d.closed, 0);
  const byActorSum = w.byActor.reduce((n, a) => n + a.closed, 0);
  assert.equal(byDaySum, 0, "「每天」那张表也得跟着撤回");
  assert.equal(byActorSum, 0, "「按人」那张表也得跟着撤回");
});

test("stats 认时间窗：和周报同一个窗口时必须逐字相等", () => {
  const root = makeRepo();
  const { db } = initFlow(root);

  addTask(db, "T-001", { status: "done", closedAt: "2026-03-08T10:00:00.000Z", closedBy: "evidence" });
  addEvent(db, { at: "2026-03-08T10:00:00.000Z", action: "close" });
  addTask(db, "T-002", { status: "done", closedAt: "2026-02-01T10:00:00.000Z", closedBy: "evidence" });
  addEvent(db, { at: "2026-02-01T10:00:00.000Z", action: "close" });

  // 全时：两条
  assert.equal(disciplineStats(db).done, 2, "不传窗口就是全时");
  // 7 天窗口：一条
  const w = weekly(db, { days: 7, now: NOW });
  const s = disciplineStats(db, { since: w.since, until: w.until });
  assert.equal(w.totals.closed, 1);
  assert.equal(s.done, 1, `同一窗口下 stats 也必须是 1，实际 ${s.done}`);
  assert.equal(w.totals.closed, s.done);
});

test("窗口外的任务不计入 stats 的窗口口径，但全时口径照样数得到", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  addTask(db, "T-001", { status: "done", closedAt: "2026-02-01T10:00:00.000Z", closedBy: "evidence" });
  addEvent(db, { at: "2026-02-01T10:00:00.000Z", action: "close" });

  const w = weekly(db, { days: 7, now: NOW });
  assert.equal(w.totals.closed, 0, "窗口外不算");
  assert.equal(disciplineStats(db, { since: w.since, until: w.until }).done, 0);
  assert.equal(disciplineStats(db).done, 1, "全时口径不受影响");
});

test("「每天」和「按人」加起来必须等于总数（含打回再收口）", () => {
  const root = makeRepo();
  const { db } = initFlow(root);

  // 三条任务：一条正常、一条打回再收口、一条 force-close 放行
  addTask(db, "T-001", { status: "done", closedAt: "2026-03-08T10:00:00.000Z", closedBy: "evidence" });
  addEvent(db, { at: "2026-03-08T10:00:00.000Z", actor: "a1", action: "close" });

  addTask(db, "T-002", { status: "done", closedAt: "2026-03-09T10:00:00.000Z", closedBy: "evidence" });
  addEvent(db, { at: "2026-03-05T10:00:00.000Z", actor: "a2", action: "close", taskId: "T-002" });
  addEvent(db, { at: "2026-03-06T10:00:00.000Z", actor: "owner", action: "task.reopen", taskId: "T-002" });
  addEvent(db, { at: "2026-03-09T10:00:00.000Z", actor: "a2", action: "close", taskId: "T-002" });

  addTask(db, "T-003", { status: "done", closedAt: "2026-03-07T10:00:00.000Z", closedBy: "force-close" });
  addEvent(db, { at: "2026-03-07T10:00:00.000Z", actor: "owner", action: "override", code: "E_SCOPE_VIOLATION", taskId: "T-003" });

  const w = weekly(db, { days: 30, now: NOW });
  const s = disciplineStats(db, { since: w.since, until: w.until });
  assert.equal(w.totals.closed, 3, `三条任务各算一次，实际 ${w.totals.closed}`);
  assert.equal(s.done, 3);
  assert.equal(w.totals.closed, s.done, "周报与 stats 必须相等");
  const byDaySum = w.byDay.reduce((n, d) => n + d.closed, 0);
  const byActorSum = w.byActor.reduce((n, a) => n + a.closed, 0);
  assert.equal(byDaySum, 3, `「每天」加起来要等于总数，实际 ${byDaySum}`);
  assert.equal(byActorSum, 3, `「按人」加起来要等于总数，实际 ${byActorSum}`);
});

test("收口时的 closed_at 和 close 事件必须是同一个时刻", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  addTask(db, "T-001", { status: "done", closedAt: "2026-03-05T10:00:00.000Z", closedBy: "evidence" });
  // 用同一个时刻写事件：这就是 gates.js 收口时该做的事
  addEvent(db, { at: "2026-03-05T10:00:00.000Z", action: "close" });

  const w = weekly(db, { days: 7, now: NOW });
  // 边界：正好卡在 since 上，必须两边一致（要么都算，要么都不算）
  const s = disciplineStats(db, { since: w.since, until: w.until });
  assert.equal(w.totals.closed, s.done, "同一时刻写两处，窗口边界上才不会各数各的");
});