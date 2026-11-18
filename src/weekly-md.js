// devcontrol — 周报的渲染层：只排版，不决策。
// 口径全在 weekly.js，这里负责把那些数字变成人能扫一眼的 markdown。
import { verdict } from "./weekly.js";

const day = (iso) => String(iso).slice(0, 10);

const table = (head, rows) => [
  `| ${head.join(" | ")} |`,
  `|${head.map(() => " --- ").join("|")}|`,
  ...rows.map((r) => `| ${r.join(" | ")} |`),
];

/**
 * 把 weekly() 的结果渲染成 markdown。
 * @param {ReturnType<import("./weekly.js").weekly>} w
 * @param {{title?: string}} opts
 */
export function renderWeekly(w, { title = "周报" } = {}) {
  const out = [`# ${title} ${day(w.since)} ~ ${day(w.until)}`, "", verdict(w), ""];

  out.push("## 每天", "");
  if (!w.byDay.length) {
    out.push("_这周一条事件都没有_", "");
  } else {
    out.push(
      ...table(
        ["日期", "新建", "领取", "收口", "被拦", "放行"],
        w.byDay.map((d) => [d.day, d.created, d.claimed, d.closed, d.blocked, d.overridden]),
      ),
      "",
    );
  }

  out.push("## 按人", "");
  if (!w.byActor.length) {
    out.push("_这周没人领活_", "");
  } else {
    out.push(
      ...table(
        ["谁", "收口", "领取", "被拦"],
        w.byActor.map((a) => [a.actor, a.closed, a.claimed, a.blocked]),
      ),
      "",
    );
  }
  // 被拦的码只列前 5：周报是给人扫的，不是日志全文
  if (w.topBlocked.length) {
    out.push("## 主要拦在哪", "");
    for (const b of w.topBlocked) out.push(`- \`${b.code}\` × ${b.count}`);
    out.push("");
  }

  // 不进「被拦」的两类也要摊开：不写，读者会以为这周干干净净；
  // 写成「被拦」，又等于把打错命令和内核的 bug 都算成内核抓住了问题（T-118/T-119）。
  const aside = [];
  if (w.totals.envOnly) aside.push(`- 补一步就好（用法/环境类）：${w.totals.envOnly} 次`);
  if (w.totals.faults) aside.push(`- 内核自身故障：${w.totals.faults} 次（不算 Agent 的账，值得上报）`);
  if (aside.length) {
    out.push("## 不进「被拦」的那些", "", ...aside, "");
  }

  return out.join("\n").replace(/\n+$/, "\n");
}
