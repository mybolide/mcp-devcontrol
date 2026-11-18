// devcontrol — 周报的统计层：只算数，不管怎么排版。
//
// 数据全在 events / tasks / runs 里：事件流是「发生了什么」的账本，runs 是「跑成没成」的账本，
// 这里只是按天、按人把它们归拢一下。分开写是为了让渲染层能换样子而不动口径。

import { countGateRounds, countRework, ENV_ONLY_CODES, FAULT_CODES } from "./store.js";

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

  // 只需要事实（code），不需要写入时记下的分类结论：怎么算「被拦」在这里现算（T-118）。
  const events = db
    .prepare("SELECT at, actor, channel, action, task_id, code FROM events WHERE at >= ? AND at <= ? ORDER BY at")
    .all(since, until);

  const byDay = new Map();
  const byActor = new Map();
  const blockedCodes = new Map();
  const totals = { created: 0, claimed: 0, closed: 0, blocked: 0, envOnly: 0, faults: 0, overridden: 0, reworks: 0 };
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
      // 收口事件只说明「这一下过了」；返工怎么算见下面的 totals.reworks
    } else if (e.action === "close.fail" || e.action === "rejected") {
      // 收口失败和被拒绝是同一类事：内核不让过。至于算不算「被拦」，按 code 现算——
      // 名单会演进，历史行不会自我更新，所以写入时记下的结论一概不采信（T-118）。
      if (FAULT_CODES.has(e.code)) {
        // 内核自己崩了：不是 Agent 的账，但也不能让它消失——单独摊出来（T-119）。
        totals.faults += 1;
      } else if (ENV_ONLY_CODES.has(e.code)) {
        totals.envOnly += 1;
      } else {
        totals.blocked += 1;
        bump(byDay, d, "blocked");
        bumpActor(e.actor, "blocked");
        if (e.code) blockedCodes.set(e.code, (blockedCodes.get(e.code) ?? 0) + 1);
      }
    } else if (e.action === "override") {
      totals.overridden += 1;
      bump(byDay, d, "overridden");
    }
  }

  // 与 disciplineStats 拆成两笔、两笔都算：① 门禁拒了几轮 ② 跑挂过又跑过了（T-116）。
  // 早先这里只数第 ② 笔，于是同一个词在 stats 是 28 轮、在周报是 2 轮，读者没法判断该信谁（T-119）。
  totals.reworks = countGateRounds(db, { since, until }) + countRework(db, { since, until });
  // 「收口几条」早先只数 close 事件，于是 Owner 用 force-close 放行收口的那几条
  // 在周报里凭空消失：stats 说「已完成 119」、周报说「收口 116」，同一个词两个数（T-121）。
  // 这里只补这一笔差额——不放宽 close 的口径，也不改「任务规模从 tasks 取」的老约定。
  const closedTasks = db
    .prepare("SELECT id, changed_lines, closed_at, closed_by FROM tasks WHERE closed_at >= ? AND closed_at <= ?")
    .all(since, until);
  const lines = closedTasks.reduce((n, t) => n + (t.changed_lines ?? 0), 0);
  const closedEventTasks = new Set(events.filter((e) => e.action === "close").map((e) => e.task_id));
  for (const t of closedTasks) {
    if (closedEventTasks.has(t.id)) continue;
    // 没有 close 事件却已经 done 的，只会是 Owner 用 override 放行收口的
    // （closed_by='force-close'）。按天归到收口那天，按人记在 owner 名下——
    // 这是 Owner 签的字，不是某个 Agent 自己收的工。
    if (t.closed_by !== "force-close") continue;
    const d = dayOf(t.closed_at);
    totals.closed += 1;
    bump(byDay, d, "closed");
    bumpActor("owner", "closed");
  }

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
  // 「补一步就好」的那几次也说出来：不说，读者会以为这周什么都没发生；
  // 说成「被拦」，又等于把打错命令算成内核抓住了问题（T-117/T-118）。
  if (t.envOnly) parts.push(`另有 ${t.envOnly} 次补一步就好`);
  // 内核自己的故障必须单独说：混进「被拦」是冤枉 Agent，藏起来是替内核遮丑（T-119）。
  if (t.faults) parts.push(`内核自身故障 ${t.faults} 次（不算你的账，值得上报）`);
  if (t.reworks) parts.push(`返工 ${t.reworks} 轮`);
  if (t.overridden) parts.push(`Owner 放行 ${t.overridden} 次`);
  if (t.lines) parts.push(`净改动 ${t.lines} 行`);
  return parts.join(" · ");
}