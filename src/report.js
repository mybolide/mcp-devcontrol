// devcontrol — doctor 对账 + markdown 导出
import fs from "node:fs";
import path from "node:path";
import { memoryConfig, memoryStatus } from "./memory.js";
import { metaGet } from "./db.js";
import { listTasks, listReqs, listBugs, listDocs, listPaths } from "./store.js";
import { head, isAncestor, statusPorcelain } from "./git.js";
import { SKILL_REL, skillContent } from "./skill.js";
import { sha256 } from "./fingerprint.js";
import { detectTestCmds } from "./testcmd.js";

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
  return items;
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