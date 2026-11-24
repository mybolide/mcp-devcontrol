// devcontrol — Path 与该需求里未覆盖的验收之间的匹配
//
// 为什么单独一个模块：`next` 以前是「这条需求的第一条 approved Path」，
// 于是 FR-007 有三条已批准 Path 时永远推荐 P-002（它只授权两个 spike 文件），
// 而真正要干的活在 P-006 / P-007 里。那不是"推荐得不够好"，是**静默给错授权范围**：
// Agent 照抄就得到一条注定撞 E_SCOPE_VIOLATION 或继承别家验收的任务。
//
// 这里的规则只有一条：**按要跑的验收命令去选 Path，选不出来就明说为什么**。
//   · 只在该需求自己的 Path 里选（跨需求借用一律不认，那是别人的授权）；
//   · 只看 approved（draft 是提案，revoked 已作废）；
//   · Path 契约里冻结的验收命令必须包含这条验收的命令——同一份契约才谈得上履行；
//   · 命中多条时取「范围最窄的那条」：窄的更贴合当前阶段，容错空间也更小（不是更松）；
//   · 一条都命中不了时，把每条 Path 差在哪写清楚，让人能补一条 Path 或改验收，而不是猜。
import { getPath } from "./store.js";
import { assertionCommand } from "./testcmd.js";

/** 一条 Path 能不能履行某条验收：只看冻结命令里有没有它要跑的那条命令。 */
export function pathCoversAssertion(path, assertion) {
  const command = assertionCommand(String(assertion ?? ""));
  if (!command) return false;
  return (path.testCmds ?? []).includes(command);
}

/**
 * 给一条验收挑 Path。
 * @returns {{path: object|null, reason: string, candidates: Array<{id:string,why:string}>}}
 *   path 为 null 时 reason 是人能照着办事的诊断，candidates 里是每条候选差在哪。
 */
export function matchPathForAssertion({ paths, requirementId, assertion }) {
  const own = paths.filter((p) => p.requirement_id === requirementId);
  if (!own.length) {
    return { path: null, reason: `需求 ${requirementId} 还没有任何 Path`, candidates: [] };
  }
  const approved = own.filter((p) => p.status === "approved");
  if (!approved.length) {
    return {
      path: null,
      reason: `需求 ${requirementId} 的 ${own.length} 条 Path 都还没批准（${own.map((p) => `${p.id}:${p.status}`).join("、")}）`,
      candidates: own.map((p) => ({ id: p.id, why: p.status })),
    };
  }
  const hit = approved.filter((p) => pathCoversAssertion(p, assertion));
  if (hit.length) {
    // 范围最窄的优先：allowedPaths 总数最少、总长度最短
    const size = (p) => (p.allowedPaths?.length ?? 0) * 1000 + (p.allowedPaths ?? []).join(",").length;
    const sorted = [...hit].sort((a, b) => size(a) - size(b) || String(a.id).localeCompare(String(b.id)));
    return { path: sorted[0], reason: "冻结了这条验收命令", candidates: hit.map((p) => ({ id: p.id, why: "命中" })) };
  }
  const command = assertionCommand(String(assertion ?? ""));
  return {
    path: null,
    reason: `需求 ${requirementId} 下没有一条已批准 Path 冻结了 \`${command}\`：给需要的阶段新建一条 Path 并加进这条命令，或让 Owner 用 path adjust 补上`,
    candidates: approved.map((p) => ({
      id: p.id,
      why: `允许 ${(p.allowedPaths ?? []).join("、") || "?"}；冻结命令 ${(p.testCmds ?? []).join("、") || "（无）"}`,
    })),
  };
}

/**
 * 二级校验：任务的 scope 必须落在它那条 Path 的授权范围里（已经是门禁，这里只做诊断）。
 * 返回 null 表示没问题，否则返回一句人话——这样 next/bootstrap 能提前说，
 * 而不是让人挨到 claim 才吃 E_CONTRACT。
 */
export function scopeOutsidePath(path, scope) {
  if (!path) return `Path 不存在`;
  const allowed = path.allowedPaths ?? [];
  if (!allowed.length) return `${path.id} 没有允许范围`;
  const bad = (scope ?? []).filter((s) => {
    const probe = `${String(s).replace(/\/+$/, "")}/x`;
    const norm = (v) => String(v).replace(/\/+$/, "");
    return !allowed.some((a) => {
      const base = norm(a);
      return base === "." || probe === base || probe.startsWith(`${base}/`) || base.startsWith(`${norm(s)}/`);
    });
  });
  return bad.length ? `${bad.join("、")} 不在 ${path.id} 的允许范围（${allowed.join("、")}）` : null;
}

/** 便捷：按 requirementId 找一条 Path（给调用方少写一层 getPath） */
export function pathOf(db, id) {
  return id ? getPath(db, id) : null;
}
