// devcontrol — 需求级结果汇总（P2：统一项目完成结果）
//
// 「这一条需求做完了没有、交付了什么、凭什么说做完了、还有什么没解决、需要 Owner 做什么」
// 现在是散在任务、证据、事件里的。一次汇总出来，Agent Studio 那边就不用自己拼，
// 也不用把过程里的每次工具调用都当通知推给人。
import { getReq, getTask, listPaths, listTasks } from "./store.js";

/** 一条需求的最终结果（只读，不改任何状态）。 */
export function requirementResult(db, requirementId) {
  const req = getReq(db, requirementId);
  if (!req) return null;
  const tasks = listTasks(db).filter((t) => t.requirement_id === req.id);
  const paths = listPaths(db).filter((p) => p.requirement_id === req.id);

  // 验收覆盖：哪条验收被哪些任务认领、最后一次证据过没过
  const acceptance = req.acceptance.map((text, idx) => {
    const owners = tasks.filter((t) => t.acceptance.some((a) => a.deriveFrom === idx));
    const dones = owners.filter((t) => t.status === "done");
    return {
      idx,
      assertion: text,
      coveredBy: owners.map((t) => t.id),
      done: dones.length > 0,
      pending: owners.filter((t) => !["done", "abandoned"].includes(t.status)).map((t) => t.id),
    };
  });

  const completions = tasks.flatMap((t) =>
    (t.completions ?? []).map((c) => ({
      taskId: t.id,
      sequence: c.sequence,
      closedAt: c.closedAt,
      closedBy: c.closedBy,
      delivery: c.delivery,
      summary: c.summary,
      changes: c.changes,
      limitations: c.limitations,
      commits: (c.commits ?? []).map((x) => ({ sha: x.sha, subject: x.subject })),
      runs: (c.runs ?? []).map((r) => ({ command: r.command, exitCode: r.exitCode, runId: r.runId })),
    })),
  );

  const open = (code) => db.prepare("SELECT id, task_id, question FROM questions WHERE status='open' AND task_id IN (" + tasks.map(() => "?").join(",") + ")").all(...tasks.map((t) => t.id));
  const questions = tasks.length ? open() : [];

  return {
    requirementId: req.id,
    title: req.title,
    status: req.status,
    acceptance,
    acceptanceDone: acceptance.filter((a) => a.done).length,
    acceptanceTotal: acceptance.length,
    tasks: tasks.map((t) => ({ id: t.id, status: t.status, delivery: t.delivery, title: t.title })),
    paths: paths.map((p) => ({ id: p.id, status: p.status, allowedPaths: p.allowedPaths })),
    changedFiles: [...new Set(completions.flatMap((c) => (c.commits ?? []).flatMap((x) => x.files ?? [])))],
    commits: [...new Set(completions.flatMap((c) => (c.commits ?? []).map((x) => x.sha)))],
    evidence: completions.flatMap((c) => c.runs),
    limitations: completions.map((c) => ({ taskId: c.taskId, limitations: c.limitations })).filter((x) => x.limitations && x.limitations !== "无"),
    needsOwner: [
      ...questions.map((q) => ({ kind: "question", id: q.id, taskId: q.task_id, summary: q.question })),
      ...tasks
        .filter((t) => ["parked"].includes(t.status))
        .map((t) => ({ kind: "parked", id: t.id, taskId: t.id, summary: `${t.id} ${t.title}` })),
    ],
    openTasks: tasks.filter((t) => !["done", "abandoned"].includes(t.status)).map((t) => t.id),
    conclusion:
      acceptance.every((a) => a.done) && !tasks.some((t) => !["done", "abandoned"].includes(t.status))
        ? "已完成：每条验收都有任务交付并收口"
        : "未完成：还有验收没人交付，或有任务没收口",
  };
}
