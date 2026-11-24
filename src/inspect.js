// devcontrol — 查询能力（P2-7）：任务状态 / 验收结果 / 失败原因 / 待决策。
//
// 这些数据内核一直都有（runs、events、task_completions、questions），但只能靠翻库或
// 读控制台一个页面一个页面地看。Agent 想知道「这条任务为什么失败过」「上次验收证据是什么」，
// 人不该再教它去查 SQLite。
import { getTask, listTasks } from "./store.js";
import { reworkState, reworkReport } from "./rework.js";

/** 一条任务的完整状态：状态机、可返工性、最近证据、失败与返工历史。 */
export function taskStatus(db, id) {
  const task = getTask(db, id);
  if (!task) return null;
  const runs = db
    .prepare("SELECT id, command, exit_code, head, started_at FROM runs WHERE task_id=? ORDER BY started_at DESC LIMIT 10")
    .all(id)
    .map((r) => ({ runId: r.id, command: r.command, exit: r.exit_code, head: String(r.head ?? "").slice(0, 8), at: r.started_at }));
  const failures = db.prepare("SELECT code, detail, at FROM events WHERE task_id=? AND action='close.fail' ORDER BY id").all(id);
  const reworks = db.prepare("SELECT detail, at FROM events WHERE task_id=? AND action='task.rework' ORDER BY id").all(id);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    delivery: task.delivery,
    requirementId: task.requirement_id,
    pathId: task.path_id,
    scope: task.scope,
    acceptance: task.acceptance.map((a) => a.assertion),
    state: reworkState(db, task),
    runs,
    failures,
    reworks,
    completions: (task.completions ?? []).map((c) => ({ sequence: c.sequence, closedBy: c.closedBy, closedAt: c.closedAt, delivery: c.delivery })),
  };
}

/** 验收结果：每条验收最后一条证据 + 过没过。 */
export function acceptanceStatus(db, id) {
  const task = getTask(db, id);
  if (!task) return null;
  return {
    taskId: task.id,
    status: task.status,
    items: task.acceptance.map((item, idx) => {
      const run = db
        .prepare("SELECT id, command, exit_code, head, started_at FROM runs WHERE task_id=? AND command=? ORDER BY started_at DESC LIMIT 1")
        .get(id, String(item.assertion).split("::")[0].trim());
      return {
        idx,
        assertion: item.assertion,
        passed: run ? run.exit_code === 0 : null,
        runId: run?.id ?? null,
        at: run?.started_at ?? null,
        head: run ? String(run.head ?? "").slice(0, 8) : null,
      };
    }),
  };
}

/** 失败原因：一个任务的失败时间线 + 给人看的报告。 */
export function failureStatus(db, id) {
  const report = reworkReport(db, id);
  if (!report) return null;
  return {
    taskId: id,
    state: report.state.state,
    owner: report.state.owner,
    reason: report.state.reason,
    attempts: report.attempts,
    reworks: report.reworks,
    notes: report.notes,
  };
}

/** 待决策清单：只有该人拍板的事（问题 + 要 Owner 的挂起 + 返工用完）。 */
export function decisions(db) {
  const out = [];
  for (const q of db.prepare("SELECT id, task_id, question, expires_at FROM questions WHERE status='open' ORDER BY id").all()) {
    out.push({ kind: "question", id: q.id, taskId: q.task_id, summary: String(q.question ?? "").slice(0, 160), expiresAt: q.expires_at });
  }
  // 同一个任务只出一条：已经有待回答问题的任务，问题那条就代表了它
  const asked = new Set(out.filter((x) => x.kind === "question").map((x) => x.taskId));
  for (const t of listTasks(db).filter((x) => x.status === "parked")) {
    if (asked.has(t.id)) continue;
    const st = reworkState(db, t);
    if (st.owner === "agent") continue;
    out.push({ kind: st.state === "failed" ? "rework-exhausted" : "needs-owner", id: t.id, taskId: t.id, summary: `${t.id} ${t.title}`, reason: st.reason });
  }
  return out;
}