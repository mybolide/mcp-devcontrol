// devcontrol — task.close 的结构化交付记录
//
// 这三个字段回答的是「这次交付了什么」，runs / commits 则是「凭什么说它过了」。
// 两类数据由不同的来源产生，不能让 Agent 写一句「测试通过」代替内核核验。
// 本模块只负责说明校验和 append-only 持久化；调用方必须在已经验证证据后，
// 把 insertCompletion 放进与 task.done 同一个 SQLite 事务。
import { randomUUID } from "node:crypto";
function failCompletion(code, message, data = undefined) {
  const error = new Error(message);
  error.code = code;
  if (data !== undefined) error.data = data;
  throw error;
}

export const COMPLETION_LIMITS = Object.freeze({
  summary: 4000,
  changes: 16000,
  limitations: 8000,
});

/** 校验正常验收收口的交付说明；不做 String(value) 强转，类型错要 fail closed。 */
export function validateCompletionInput(input = {}) {
  const out = {};
  for (const [field, limit] of Object.entries(COMPLETION_LIMITS)) {
    const value = input[field];
    if (typeof value !== "string") {
      failCompletion("E_NEED_COMPLETION", `task.close 必须提供 ${field}（${fieldLabel(field)}）`);
    }
    const text = value.trim();
    if (!text) failCompletion("E_NEED_COMPLETION", `task.close 的 ${field} 不能为空（${fieldLabel(field)}）`);
    if (text.length > limit) {
      failCompletion("E_NEED_COMPLETION", `task.close 的 ${field} 超过 ${limit} 字符（当前 ${text.length}）`, { field, limit, length: text.length });
    }
    out[field] = text;
  }
  return out;
}

function fieldLabel(field) {
  return ({ summary: "完成结论", changes: "主要改动", limitations: "遗留限制（无遗留请填「无」）" })[field] ?? field;
}

/**
 * 在调用方事务内追加一条交付记录。
 *
 * @returns {{id:string,taskId:string,sequence:number,closedAt:string,closedBy:string}}
 */
export function insertCompletion(db, {
  taskId,
  actor,
  closedAt,
  closedBy,
  summary,
  changes,
  limitations,
  fingerprint = null,
  runs = [],
  commits = [],
  delivery = "code",
}) {
  const sequence = db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM task_completions WHERE task_id=?").get(taskId).n;
  const id = `completion-${randomUUID()}`;
  db.prepare(`
    INSERT INTO task_completions(
      id, task_id, sequence, actor, closed_at, closed_by,
      summary, changes, limitations, fingerprint, runs_json, commits_json, delivery
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id,
    taskId,
    sequence,
    actor,
    closedAt,
    closedBy,
    summary,
    changes,
    limitations,
    fingerprint,
    JSON.stringify(runs),
    JSON.stringify(commits),
    delivery,
  );
  return { id, taskId, sequence, closedAt, closedBy };
}

export function listCompletions(db, taskId) {
  return db.prepare("SELECT * FROM task_completions WHERE task_id=? ORDER BY sequence DESC").all(taskId).map(mapCompletion);
}

export function listCompletionsForTasks(db, taskIds) {
  if (!taskIds.length) return new Map();
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM task_completions WHERE task_id IN (${placeholders}) ORDER BY task_id, sequence DESC`).all(...taskIds);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.task_id)) grouped.set(row.task_id, []);
    grouped.get(row.task_id).push(mapCompletion(row));
  }
  return grouped;
}

export function mapCompletion(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    actor: row.actor,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    summary: row.summary,
    changes: row.changes,
    limitations: row.limitations,
    fingerprint: row.fingerprint,
    delivery: row.delivery ?? "code",
    runs: JSON.parse(row.runs_json),
    commits: JSON.parse(row.commits_json),
  };
}

/** Owner 绕过验收门禁时只保留其理由，绝不伪装 runs/commits 或正常验收结果。 */
export function forceCloseCompletionInput(reason) {
  if (typeof reason !== "string" || !reason.trim()) failCompletion("E_CONTRACT", "force-close 必须提供 Owner 理由");
  const text = reason.trim();
  if (text.length > COMPLETION_LIMITS.limitations) {
    failCompletion("E_CONTRACT", `force-close 理由超过 ${COMPLETION_LIMITS.limitations} 字符`);
  }
  return {
    summary: "Owner 强制完成（未经验收）",
    changes: "未由验收收口流程核验；详见 Owner 强制完成理由。",
    limitations: text,
  };
}
