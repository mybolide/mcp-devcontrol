// devcontrol — 周报的统计层：只算数，不管怎么排版。
//
// 数据全在 events / tasks 里，不需要新表：事件流本来就是"发生了什么"的账本，
// 这里只是按天、按人把它归拢一下。分开写是为了让渲染层能换样子而不动口径。

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
      // 收口事件里带着"失败过几次"的信息：detail 形如「578 行 / 26 文件 / 1 断言」
      // 返工次数单独从 close.fail 数，这里不猜。
    } else if (e.action === "close.fail") {
      totals.blocked += 1;
      bump(byDay, d, "blocked");
      bumpActor(e.actor, "blocked");
      // 「返工」= 同一任务失败后又收口成功；这里先按失败次数记，够用且不骗人
      totals.reworks += 1;
      if (e.code) blockedCodes.set(e.code, (blockedCodes.get(e.code) ?? 0) + 1);
    } else if (e.action === "override") {
      totals.overridden += 1;
      bump(byDay, d, "overridden");
    }
  }

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
  if (t.overridden) parts.push(`Owner 放行 ${t.overridden} 次`);
  if (t.lines) parts.push(`净改动 ${t.lines} 行`);
  return parts.join(" · ");
}