// devcontrol — 周报的统计层：只算数，不管怎么排版。
//
// 数据全在 events / tasks / runs 里：事件流是「发生了什么」的账本，runs 是「跑成没成」的账本，
// 这里只是按天、按人把它们归拢一下。分开写是为了让渲染层能换样子而不动口径。

import { countRework } from "./store.js";

const DAY = 86_400_000;

const dayOf = (iso) => String(iso).slice(0, 10);

/**
 * 汇总一个时间窗内的事。
 * @param {object} db
 * @param {{days?: number, now?: Date}} opts
 */
export function weekly(db, { days = 7, now = new Date() } = {}) {
  if (!Number.isFinite(days) || days <= 0) {
    throw Object.assign(new Error(`天数必须是正数：${days}`), { code: "E_INVALID" });
  }
  const until = now.toISOString();
  const since = new Date(now.getTime() - days * DAY).toISOString();

  const events = db
    .prepare("SELECT at, actor, channel, action, task_id, code FROM events WHERE at >= ? AND at <= ? ORDER BY at")
    .all(since, until);

  const byDay = new Map();
  const byActor = new Map();
  const blockedCodes = new Map();
  const totals = { created: 0, claimed: 0, closed: 0, blocked: 0, overridden: 0, reworks: 0 };

  const bump = (map, key, field, n = 1) => {
    const cur = map.get(key) ?? { day: key, created: 0, claimed: 0, closed: 0, blocked: 0, overridden: 0 };
    cur[field] += n;
    map.set(key, cur);
  };
  const bumpActor = (actor, field) => {
    const cur = byActor.get(actor) ?? { actor, closed: 0, claimed: 0, blocked: 0 };
    cur[field] += 1;
    byActor.set(actor, cur);
  };

  for (const e of events) {
    const d = dayOf(e.at);
    if (e.action === "task.create") {
      totals.created += 1;
      bump(byDay, d, "created");
    } else if (e.action === "task.claim") {
      totals.claimed += 1;
      bump(byDay, d, "claimed");
      bumpActor(e.actor, "claimed");
    } else if (e.action === "close") {
      totals.closed += 1;
      bump(byDay, d, "closed");
      bumpActor(e.actor, "closed");
      // 收口事件只说明「这一下过了」；返工是「跑挂过几次」，得看证据，见下面的 totals.reworks
    } else if (e.action === "close.fail") {
      totals.blocked += 1;
      bump(byDay, d, "blocked");
      bumpActor(e.actor, "blocked");
      if (e.code) blockedCodes.set(e.code, (blockedCodes.get(e.code) ?? 0) + 1);
    } else if (e.action === "rejected" && e.detail !== "env-only") {
      // 被拒绝也是「被拦」：claim/commit/create 阶段的拒绝和收口失败一样进这个数。
      // 只统计 env-only 以外的，那类属于「补一步就好」（T-097）。
      totals.blocked += 1;
      bump(byDay, d, "blocked");
      bumpActor(e.actor, "blocked");
      if (e.code) blockedCodes.set(e.code, (blockedCodes.get(e.code) ?? 0) + 1);
    } else if (e.action === "override") {
      totals.overridden += 1;
      bump(byDay, d, "overridden");
    }
  }

  // 「返工」的事实是「跑挂过、之后又跑过了」，只有 runs 表说得清：不从事件数，
  // 按证据的时间窗单独算（与 disciplineStats 同一口径，免得两处数字打架）。
  totals.reworks = countRework(db, { since, until });

  // 这段时间里收口的任务规模：从 tasks 表按 closed_at 取，比数事件准
  const closedTasks = db
    .prepare("SELECT id, changed_lines, closed_at FROM tasks WHERE closed_at >= ? AND closed_at <= ?")
    .all(since, until);
  const lines = closedTasks.reduce((n, t) => n + (t.changed_lines ?? 0), 0);

  return {
    since,
    until,
    days,
    totals: { ...totals, tasks: closedTasks.length, lines },
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byActor: [...byActor.values()].sort((a, b) => b.closed - a.closed || a.actor.localeCompare(b.actor)),
    topBlocked: [...blockedCodes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
      .slice(0, 5),
  };
}

/** 一句话结论：给人看的摘要行，两三种情况各说各的 */
export function verdict(w) {
  const t = w.totals;
  if (!t.closed && !t.created) return "这一周没有动工记录";
  const pass = t.claimed ? Math.round((t.closed / t.claimed) * 100) : 0;
  const parts = [`收口 ${t.closed} 条（领了 ${t.claimed}，成率 ${pass}%）`];
  if (t.blocked) parts.push(`被拦 ${t.blocked} 次`);
  if (t.reworks) parts.push(`返工 ${t.reworks} 轮`);
  if (t.overridden) parts.push(`Owner 放行 ${t.overridden} 次`);
  if (t.lines) parts.push(`净改动 ${t.lines} 行`);
  return parts.join(" · ");
}