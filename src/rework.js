// devcontrol — Agent 自主返工（task.rework / task.resume）
//
// 现场：一个任务连续 3 次验收不过就被 park，然后**只有 Owner 能 reopen**。
// 结果 Owner 被叫去看一堆根本不需要他判断的事：「测试没过 → 改代码 → 再跑」，
// 这中间的每一次失败都不该走到他面前。
//
// 这里的边界（不许越）：
//   · 返工**不碰合同**：scope、预算、验收命令、Path 一个字节都不动；想扩权得 Owner 重新批。
//   · 只有「Agent 自己能修」的失败才允许自主重试。授权类失败（没批、契约不符、Owner 拒绝、
//     别人持有、被废弃）一律交回人——那不是多试几次能变的。
//   · 次数有上限，用完就把「试过什么、卡在哪」整理成一份报告，这才是该给 Owner 看的东西。
//   · 每一次返工都留审计（task.rework），失败历史一条不删。
import { logEvent, tx } from "./db.js";
import { getTask, now, fail } from "./store.js";

/** Agent 自己能修的失败：改代码、补证据、撤改动、重跑。 */
export const AGENT_FIXABLE = new Set([
  "E_ASSERTION_FAILED",
  "E_NO_EVIDENCE",
  "E_EVIDENCE_STALE",
  "E_EVIDENCE_STALE_HEAD",
  "E_NO_DELIVERY",
  "E_DIRTY_SCOPE",
  "E_SCOPE_VIOLATION",
  "E_UNOWNED_COMMIT",
  "E_VERIFY_COMMITTED",
  "E_UNMERGED_WORK",
  "E_DIFF_BUDGET",
  "E_NEED_COMPLETION",
  "E_CONTEXT_UNREVIEWED",
  "E_NEED_RESOLUTION",
  "E_EXTRA_SCOPE",
]);

/** 授权/协作类：只有人能解，Agent 再试一百次也一样。 */
export const NEEDS_OWNER = new Set([
  "E_NEED_APPROVED",
  "E_CONTRACT",
  "E_NO_CONTRACT",
  "E_PATH_IN_USE",
  "E_APPROVAL_STALE",
  "E_OWNER_DECLINED",
  "E_OWNER_CONFIRMATION_UNAVAILABLE",
  "E_ILLEGAL_TRANSITION",
  "E_CLAIMED_BY_OTHER",
  "E_ABANDONED",
  "E_PARKED",
  "E_WIP_LIMIT",
  "E_SCOPE_OVERLAP",
  "E_FILE_OVERLAP",
  "E_DEP_OPEN",
]);

/** 一个任务最多自主返工几次（不含最初的 3 次验收尝试）。 */
export const MAX_REWORK = 3;

function lastFailure(db, taskId) {
  return db.prepare("SELECT code, detail, at FROM events WHERE task_id=? AND action='close.fail' ORDER BY id DESC LIMIT 1").get(taskId) ?? null;
}

function openQuestion(db, taskId) {
  return db.prepare("SELECT id FROM questions WHERE task_id=? AND status='open' LIMIT 1").get(taskId) ?? null;
}

/** 已经自主返工过几次。 */
export function reworkCount(db, taskId) {
  return db.prepare("SELECT COUNT(*) c FROM events WHERE task_id=? AND action='task.rework'").get(taskId).c;
}

/** 失败码 → 谁能解。不认识的码按「要人看」处理：不认识就别自作主张。 */
export function failureOwner(code) {
  if (!code) return "unknown";
  if (AGENT_FIXABLE.has(code)) return "agent";
  if (NEEDS_OWNER.has(code)) return "owner";
  return "owner";
}

/**
 * 派生状态（不落库）：失败/待返工/重试中/被阻塞/要 Owner/已完成。
 * 为什么不新增 status 枚举：status 是门禁在用的既有状态机，加值等于把所有门禁重写一遍；
 * 而「卡在哪、该谁动」是可以从事件与现有状态算出来的事实。
 */
export function reworkState(db, task) {
  const fail = lastFailure(db, task.id);
  const reworks = reworkCount(db, task.id);
  const question = openQuestion(db, task.id);
  const base = { lastFailure: fail ? { code: fail.code, at: fail.at } : null, reworks, remaining: Math.max(0, MAX_REWORK - reworks) };
  if (task.status === "done") return { ...base, state: "completed", owner: null };
  if (task.status === "abandoned") return { ...base, state: "abandoned", owner: null };
  if (task.status === "doing") return { ...base, state: "retrying", owner: "agent" };
  if (task.status === "backlog") return { ...base, state: "ready", owner: "agent" };
  // parked：分三种，Agent 只对第一种有处置权
  if (question) return { ...base, state: "needs_owner", owner: "owner", reason: `等 Owner 回答 ${question.id}` };
  if (!fail) return { ...base, state: "needs_owner", owner: "owner", reason: "没人说得清为什么挂起，交给人看" };
  const who = failureOwner(fail.code);
  if (who === "agent") {
    return reworks >= MAX_REWORK
      ? { ...base, state: "failed", owner: "owner", reason: `自主返工 ${reworks} 次用完，最后一次仍是 ${fail.code}` }
      : { ...base, state: "needs_rework", owner: "agent", reason: `${fail.code}，可以 task.rework 自己重试（还剩 ${MAX_REWORK - reworks} 次）` };
  }
  return { ...base, state: "needs_owner", owner: "owner", reason: `${fail.code} 是授权/协作问题，只有人能解` };
}

/** 把「试过什么、卡在哪」整理成一份人话报告——次数用完时交给人看的就是它。 */
export function reworkReport(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) return null;
  const fails = db.prepare("SELECT code, detail, at FROM events WHERE task_id=? AND action='close.fail' ORDER BY id").all(taskId);
  const reworks = db.prepare("SELECT detail, at FROM events WHERE task_id=? AND action='task.rework' ORDER BY id").all(taskId);
  const notes = db.prepare("SELECT detail, at FROM events WHERE task_id=? AND action='task.rework.note' ORDER BY id").all(taskId);
  return {
    taskId,
    title: task.title,
    status: task.status,
    scope: task.scope,
    acceptance: task.acceptance.map((a) => a.assertion),
    attempts: fails.map((f) => ({ code: f.code, detail: f.detail, at: f.at })),
    reworks: reworks.map((r) => ({ detail: r.detail, at: r.at })),
    notes: notes.map((n) => n.detail),
    state: reworkState(db, task),
    hint: fails.length
      ? `试过 ${reworks.length} 次自主返工，最后一次是 ${fails[fails.length - 1].code}：${fails[fails.length - 1].detail ?? ""}`
      : "没有失败记录",
  };
}

/**
 * Agent 自主返工：把挂起的任务放回可领取，**合同一个字不改**。
 *
 * 拒绝的三种情况都必须给出「为什么该找人」：
 *   · 失败是授权/协作类（多试几次也不会变）
 *   · 有未回答的问题（等 Owner 一句话）
 *   · 自主返工次数用完（该整理报告交人了）
 */
export function taskRework(db, { id, note, actor = "agent" } = {}) {
  return tx(db, () => {
    const t = getTask(db, id);
    if (!t) fail("NOT_FOUND", `任务不存在：${id}`);
    if (t.status !== "parked") {
      fail("E_ILLEGAL_TRANSITION", `${t.id} 当前 ${t.status}，只有挂起的任务需要返工（在办的直接干活、待办的直接领）`);
    }
    const st = reworkState(db, t);
    if (st.state === "needs_owner") {
      fail("E_NEEDS_OWNER", `${t.id} 卡在 ${st.reason}，这不是多试几次能解的：把它交给 Owner`, { state: st });
    }
    if (st.state === "failed") {
      fail("E_REWORK_EXHAUSTED", `${t.id} 自主返工 ${st.reworks} 次用完，最后一次是 ${st.lastFailure?.code}。别再试了——把 reworkReport 交给人`, {
        report: reworkReport(db, t.id),
      });
    }
    // 合同不动：把当前 pin 住的合同再确认一遍，防止「返工」被当成改口径的入口
    const moved = db.prepare("SELECT scope_json, contract_hash FROM tasks WHERE id=?").get(t.id);
    const updated = db
      .prepare("UPDATE tasks SET status='backlog', claimed_by=NULL, claim_expires_at=NULL, claim_fingerprint=NULL, closing_at=NULL, closing_token=NULL, updated_at=? WHERE id=? AND status='parked'")
      .run(now(), t.id);
    if (updated.changes !== 1) fail("E_BUSY", "任务状态刚被改过，重试一次");
    const after = db.prepare("SELECT scope_json, contract_hash FROM tasks WHERE id=?").get(t.id);
    if (after.scope_json !== moved.scope_json || after.contract_hash !== moved.contract_hash) {
      // 理论上不可能：这里只是把「返工不许改合同」变成可执行的断言，而不是一句注释
      fail("E_INTERNAL", "返工意外改动了合同（scope/契约哈希），已回滚", { before: moved, after });
    }
    const reason = String(note ?? "").trim();
    logEvent(db, {
      actor,
      action: "task.rework",
      taskId: t.id,
      detail: `第 ${st.reworks + 1}/${MAX_REWORK} 次；上次失败 ${st.lastFailure?.code ?? "?"}${reason ? `：${reason}` : ""}`,
    });
    if (reason) logEvent(db, { actor, action: "task.rework.note", taskId: t.id, detail: reason });
    return { taskId: t.id, status: "backlog", reworks: st.reworks + 1, remaining: Math.max(0, MAX_REWORK - st.reworks - 1), scope: t.scope };
  });
}

/**
 * 崩溃/租约丢失后的恢复：把「在办但已经没人」的任务放回待办，等下一个 Agent 领。
 * 不消耗返工额度（这不是失败，是人掉线），但同样不动合同。
 */
export function taskResume(db, { id, actor = "agent" } = {}) {
  return tx(db, () => {
    const t = getTask(db, id);
    if (!t) fail("NOT_FOUND", `任务不存在：${id}`);
    if (t.status !== "doing") fail("E_ILLEGAL_TRANSITION", `${t.id} 当前 ${t.status}，没有可恢复的在办会话`);
    const expired = !t.claim_expires_at || Date.parse(t.claim_expires_at) < Date.now();
    if (!expired) {
      fail("E_CLAIM_ACTIVE", `${t.id} 的租约到 ${t.claim_expires_at} 还没到期（${t.claimed_by} 可能还在干）：要么 task.renew 续租，要么等它过期`);
    }
    const before = db.prepare("SELECT scope_json, contract_hash, base_head FROM tasks WHERE id=?").get(t.id);
    const updated = db
      .prepare("UPDATE tasks SET status='backlog', claimed_by=NULL, claim_expires_at=NULL, claim_fingerprint=NULL, closing_at=NULL, closing_token=NULL, updated_at=? WHERE id=? AND status='doing'")
      .run(now(), t.id);
    if (updated.changes !== 1) fail("E_BUSY", "任务状态刚被改过，重试一次");
    const after = db.prepare("SELECT scope_json, contract_hash, base_head FROM tasks WHERE id=?").get(t.id);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail("E_INTERNAL", "恢复意外改动了合同（scope/契约/基线），已回滚");
    logEvent(db, {
      actor,
      action: "task.resume",
      taskId: t.id,
      detail: `释放过期租约（原持有者 ${t.claimed_by ?? "?"}，租约到期 ${t.claim_expires_at ?? "无"}）`,
    });
    return { taskId: t.id, status: "backlog", releasedFrom: t.claimed_by ?? null, scope: t.scope };
  });
}