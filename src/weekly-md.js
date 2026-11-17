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

  return out.join("\n").replace(/\n+$/, "\n");
}
