// devcontrol — doctor 对账 + markdown 导出
import fs from "node:fs";
import path from "node:path";
import { memoryConfig, memoryStatus } from "./memory.js";
import { metaGet } from "./db.js";
import { listTasks, listReqs, listBugs, listDocs, listPaths } from "./store.js";
import { head, isAncestor, statusPorcelain } from "./git.js";
import { SKILL_REL, skillContent } from "./skill.js";
import { sha256 } from "./fingerprint.js";
import { assertionCommand, detectTestCmds } from "./testcmd.js";
import { inScope } from "./fingerprint.js";

export function doctor(db, root) {
  const items = [];
  let h = null;
  const weak = metaGet(db, "mode") === "weak";
  try {
    h = head(root);
  } catch {
    if (!weak) items.push({ severity: "error", code: "NO_HEAD", detail: "仓库还没有提交" });
  }
  for (const t of listTasks(db)) {
    if (t.status === "done") {
      const closed = db.prepare("SELECT 1 FROM events WHERE task_id=? AND action IN ('close','override')").get(t.id);
      if (!closed) items.push({ severity: "error", code: "GHOST_DONE", taskId: t.id, detail: "标记完成但没有任何收口记录（疑似直接改库）" });
      if (t.closed_by === "override" || t.closed_by === "force-close") {
        items.push({ severity: "warn", code: "OVERRIDDEN", taskId: t.id, detail: "这条是 Owner 手下放行收口，没有跑验收" });
      }
    }
    if (t.status === "doing" && t.claim_expires_at && Date.parse(t.claim_expires_at) < Date.now()) {
      items.push({ severity: "warn", code: "STALE_CLAIM", taskId: t.id, detail: "claim 已过期，下次写操作会回收" });
    }
    if (t.status === "doing" && t.closing_at && Date.now() - Date.parse(t.closing_at) > 60 * 60_000) {
      items.push({ severity: "warn", code: "STALE_CLOSING", taskId: t.id, detail: "close 卡住超过 60 分钟" });
    }
  }
  for (const p of listPaths(db)) {
    for (const rel of p.allowedPaths) {
      if (!fs.existsSync(path.join(root, rel))) items.push({ severity: "warn", code: "STALE_PATH", detail: `${p.id} 的 allowed_path 不存在：${rel}` });
    }
    // 验收命令会不会已经过期：契约冻的是批准那一刻的命令，项目改了 test 脚本它不会自己跟。
    // 命令过期时收口跑的是一条不存在的命令，Agent 看着「失败」却不知道错在哪。
    if (p.status === "approved" && p.testCmds?.length) {
      const now = detectTestCmds(root);
      const stale = now.cmds.length ? !p.testCmds.some((c) => now.cmds.includes(c)) : false;
      if (stale) {
        items.push({
          severity: "warn",
          code: "TEST_CMD_DRIFT",
          pathId: p.id,
          detail: `${p.id} 冻结的命令是 ${p.testCmds.join(" / ")}，项目现在该用 ${now.cmds.join(" / ")}（控制台点「重采验收命令」可更新）`,
        });
      }
    }
  }
  if (weak) {
    items.push({ severity: "warn", code: "WEAK_MODE", detail: "弱模式（无 git）：只跑验收，没有提交归属/scope/预算校验" });
  }
  // 只报「属于这个项目」的记忆：别的项目留下的失败不该算在本项目头上，
  // 新项目一打开就看见十条红字，只会以为是自己坏了。
  const mem = memoryStatus(memoryConfig(process.env, root), { project: path.basename(root) });
  if (mem.enabled) {
    const failed = mem.byState?.failed ?? 0;
    const pending = mem.byState?.pending ?? 0;
    if (failed && mem.offline) {
      // 向量服务没开是环境问题，不是知识库坏了：说清楚，别让人去修一个没坏的东西
      items.push({
        severity: "info",
        code: "MEMORY_INDEX_OFFLINE",
        detail: `向量服务连不上（${mem.embedding}），${failed} 条经验暂未建索引；检索会退回关键词匹配，不影响收口`,
      });
    } else if (failed) {
      items.push({ severity: "warn", code: "MEMORY_INDEX_FAILED", detail: `${failed} 条经验没进向量索引（devcontrol memory reindex 可重建）` });
    }
    if (pending) items.push({ severity: "info", code: "MEMORY_INDEX_PENDING", detail: `${pending} 条经验等待建索引` });
  }
  for (const d of listDocs(db)) {
    const abs = path.join(root, d.path);
    if (!fs.existsSync(abs)) items.push({ severity: "warn", code: "DOC_DRIFT", detail: `文档丢失：${d.path}` });
    else if (sha256(fs.readFileSync(abs)) !== d.sha256) items.push({ severity: "warn", code: "DOC_DRIFT", detail: `文档已变化：${d.path}` });
  }
  try {
    if (statusPorcelain(root, ["--untracked-files=no", "--", ".", ":(exclude).devcontrol"])) {
      items.push({ severity: "warn", code: "DIRTY_TREE", detail: "工作树有未提交改动" });
    }
  } catch {
    /* ignore */
  }
  // 说明文件是不是当前版本写的（过期不自动改：任务在办时动它会弄脏工作树）
  try {
    const abs = path.join(root, SKILL_REL);
    if (fs.existsSync(abs) && fs.readFileSync(abs, "utf8") !== skillContent()) {
      items.push({
        severity: "warn",
        code: "SKILL_OUTDATED",
        detail: "Agent 说明是旧版本写的：收口后跑 devcontrol init（或连一次 MCP）会对齐",
      });
    }
  } catch {
    /* 读不到就跳过 */
  }
  items.push(...consistency(db));
  return items;
}

/**
 * 内核自洽检查：**只看内核自己记的东西对不对，不看仓库**。
 *
 * 为什么单独一组：其他检查都在问「Agent 做了什么」，这一组在问
 * 「内核自己有没有前后矛盾」。2026-11 的全栈演练里出现过一次典型故障：
 * Owner 在需求验收里写了 `npm run build`，批准时却只冻结了 Path 采到的 `npm test`，
 * 于是 Agent 建任何用 build 验收的任务都被 E_CONTRACT 拦住，
 * 而错误信息里完全看不出「这是 Owner 早就批准过的」。
 * 那种状态两个人都没错、页面都正常，只有把两边摊在一起比对才看得见。
 */
function consistency(db) {
  const out = [];
  const paths = listPaths(db);
  const byId = new Map(paths.map((p) => [p.id, p]));
  const tasks = listTasks(db);
  const reqs = listReqs(db);

  // 两种来源：需求的 acceptance 是字符串数组，任务的 acceptance 是 {assertion} 对象数组。
  // 混着用会让 assertionCommand 拿到 [object Object] 静默返回 null，检查形同虚设。
  const cmdOf = (a) => assertionCommand(typeof a === "string" ? a : a?.assertion);

  // ① 项目里一条已批准的 Path 都没有 → 谁都开不了工
  //
  // 注意 Path 是**可复用的**：一条 Path 能被多个需求先后批准，DB 里只留最后一次绑定。
  // 所以不能按「requirement_id 绑着谁」来判断——那样会把复用过的需求全报成孤儿（假警报）。
  // 该问的是：这个需求的验收，有没有至少一条已批准的 Path 能承载它。
  const approvedPaths = paths.filter((p) => p.status === "approved");
  if (!approvedPaths.length && reqs.some((r) => r.status === "approved")) {
    out.push({ severity: "error", code: "NO_APPROVED_PATH", detail: "有已批准的需求，但项目里一条已批准的 Path 都没有——Agent 建不了任务" });
  }

  // ② 需求的每条验收命令，至少要有一条已批准的 Path 冻结了它
  for (const r of reqs) {
    if (r.status !== "approved" || !approvedPaths.length) continue;
    const uncovered = r.acceptance
      .map(cmdOf)
      .filter((c) => c && !approvedPaths.some((p) => p.testCmds.includes(c)));
    if (uncovered.length) {
      out.push({
        severity: "error",
        code: "ACCEPTANCE_NOT_IN_CONTRACT",
        requirementId: r.id,
        detail: `${r.id} 批准的验收里有 ${uncovered.join(" / ")}，但没有任何已批准的 Path 冻结了它（现有：${[...new Set(approvedPaths.flatMap((p) => p.testCmds))].join(" / ") || "空"}）`,
      });
    }
  }

  // ③ 任务的断言命令必须在该 Path 的冻结命令里（否则这条任务永远收不了口）
  for (const t of tasks) {
    if (t.status === "done" || t.status === "abandoned") continue;
    const p = byId.get(t.path_id);
    if (!p) {
      out.push({ severity: "error", code: "TASK_PATH_UNKNOWN", taskId: t.id, detail: `${t.id} 挂的 Path ${t.path_id} 不存在` });
      continue;
    }
    const stray = t.acceptance.map(cmdOf).filter((c) => c && !p.testCmds.includes(c));
    if (stray.length) {
      out.push({
        severity: "error",
        code: "TASK_ASSERTION_DRIFT",
        taskId: t.id,
        pathId: p.id,
        detail: `${t.id} 的验收命令 ${stray.join(" / ")} 不在 ${p.id} 的契约里（${p.testCmds.join(" / ") || "空"}）——这条任务收不了口`,
      });
    }

    // ④ 任务 scope 必须在 Path 允许的区域内
    const outside = t.scope.filter((sc) => !inScope(`${String(sc).replace(/\/+$/, "")}/x`, p.allowedPaths));
    if (outside.length) {
      out.push({
        severity: "error",
        code: "TASK_SCOPE_OUTSIDE_PATH",
        taskId: t.id,
        pathId: p.id,
        detail: `${t.id} 的 scope ${outside.join(" / ")} 超出 ${p.id} 的 allowed_paths（${p.allowedPaths.join(" / ")}）`,
      });
    }

    // ⑤ 已建任务的需求必须是批准过的（否则 claim 时才炸）
    const r = reqs.find((x) => x.id === t.requirement_id);
    if (!r) {
      out.push({ severity: "error", code: "TASK_REQ_UNKNOWN", taskId: t.id, detail: `${t.id} 挂的需求 ${t.requirement_id} 不存在` });
    } else if (!["approved", "building"].includes(r.status)) {
      out.push({
        severity: "error",
        code: "TASK_REQ_NOT_APPROVED",
        taskId: t.id,
        requirementId: r.id,
        detail: `${t.id} 挂在需求 ${r.id}（${r.status}）上——这条任务领不了`,
      });
    }

    // ⑥ 还在排队的任务 pin 了旧契约：Owner 重新批准过，它记的是上一版
    if (["backlog", "parked"].includes(t.status) && p.hash && t.contract_hash && t.contract_hash !== p.hash) {
      out.push({
        severity: "warn",
        code: "TASK_CONTRACT_STALE",
        taskId: t.id,
        pathId: p.id,
        detail: `${t.id} 记的是旧契约，${p.id} 已被重新批准；领取时会自动对齐，不收口拦`,
      });
    }
  }

  // ⑦ 依赖不能指向不存在的任务，也不能成环（成环 = 永远没人能开工）
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    if (t.status === "done" || t.status === "abandoned") continue;
    for (const dep of t.dependsOn) {
      if (!taskById.has(dep)) {
        out.push({ severity: "error", code: "TASK_DEP_UNKNOWN", taskId: t.id, detail: `${t.id} 依赖的 ${dep} 不存在` });
      }
    }
  }
  const mark = new Map();
  const walkCycle = (id, trail) => {
    if (mark.get(id) === "done") return;
    if (mark.get(id) === "walking") {
      out.push({ severity: "error", code: "TASK_DEP_CYCLE", taskId: id, detail: `依赖成环：${[...trail, id].join(" → ")}` });
      return;
    }
    mark.set(id, "walking");
    for (const dep of taskById.get(id)?.dependsOn ?? []) if (taskById.has(dep)) walkCycle(dep, [...trail, id]);
    mark.set(id, "done");
  };
  for (const t of tasks) if (!mark.has(t.id)) walkCycle(t.id, []);

  return out;
}

export function exportMarkdown(db) {
  const tasks = listTasks(db);
  const reqs = listReqs(db);
  const bugs = listBugs(db);
  const lines = ["# devcontrol 快照", ""];
  lines.push("## 需求");
  for (const r of reqs) lines.push(`- ${r.id} ${r.title} · ${r.status}`);
  lines.push("", "## 任务", "| ID | 类型 | 标题 | 状态 | 验收 | 行数 |", "|---|---|---|---|---|---|");
  for (const t of tasks) {
    lines.push(`| ${t.id} | ${t.kind} | ${t.title} | ${t.status} | ${t.acceptance.map((a) => a.assertion).join("；")} | ${t.changed_lines} |`);
  }
  lines.push("", "## Bug");
  for (const b of bugs) lines.push(`- ${b.id} ${b.title} · ${b.status} · ${b.severity}`);
  return lines.join("\n");
}