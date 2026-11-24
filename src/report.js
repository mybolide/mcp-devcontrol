// devcontrol — doctor 对账 + markdown 导出
import fs from "node:fs";
import path from "node:path";
import { memoryConfig, memoryStatus } from "./memory.js";
import { metaGet } from "./db.js";
import { listTasks, listReqs, listBugs, listDocs, listPaths } from "./store.js";
import { git, head, isAncestor, statusPorcelain } from "./git.js";
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
      // 「有收口记录」只认真正收口的那两种凭据：close 事件，或者 Owner 的 force-close
      // 放行。早先把 override 一起算上，于是 waive（只是放行了某一条门禁，不改任务状态）
      // 也能让一条被手工改成 done 的任务蒙混过关（T-127）。
      const closed = db.prepare("SELECT 1 FROM events WHERE task_id=? AND action='close'").get(t.id);
      const forceClosed = t.closed_by === "force-close";
      if (!closed && !forceClosed) {
        items.push({ severity: "error", code: "GHOST_DONE", taskId: t.id, detail: "标记完成但没有任何收口记录（疑似直接改库）" });
      }
      if (forceClosed) {
        items.push({ severity: "warn", code: "OVERRIDDEN", taskId: t.id, detail: "这条是 Owner 手下放行收口，没有跑验收" });
      }
    }
    if (t.status === "doing" && t.claim_expires_at && Date.parse(t.claim_expires_at) < Date.now()) {
      items.push({ severity: "warn", code: "STALE_CLAIM", taskId: t.id, detail: `${t.id} 的领取已过期（${t.claimed_by ?? "?"} 没续租）。claim 时会自动回收，或者在控制台「任务」里点交接立刻释放` });
    }
    if (t.status === "doing" && t.closing_at && Date.now() - Date.parse(t.closing_at) > 60 * 60_000) {
      items.push({ severity: "warn", code: "STALE_CLOSING", taskId: t.id, detail: "close 卡住超过 60 分钟" });
    }
    if (t.status === "parked") {
      // parked 不是「坏了」，是「等人决定」。但它可以无限期躺着没人提，所以要在对账里点出来，
      // 并明确给出两条出路（reopen 重试 / 作废不做）——否则看的人只知道有问题、不知道能做什么。
      const days = t.updated_at ? Math.floor((Date.now() - Date.parse(t.updated_at)) / 86_400_000) : null;
      items.push({
        severity: "warn",
        code: "PARKED_TASK",
        taskId: t.id,
        detail: `${t.id} 已 parked${days !== null ? ` ${days} 天` : ""}，等你定：控制台「任务」里 reopen 重试，或在「需求」里作废`,
      });
    }
  }
  // allowed_paths 支持 glob（`dir/**`、`dir/*`）：判存在时先归一。
  // 早先直接拿 `crates/x/**` 去 existsSync，于是所有写成 `dir/**` 的 Path 都被报成
  // 「路径不存在」——误报，不是人写错了。
  const existsOnDisk = (rel) => {
    const raw = String(rel ?? "").trim().replace(/\\/g, "/");
    const base = raw.replace(/\/\*{1,2}$/, "").replace(/\/+$/, "");
    if (!base || base === ".") return true;
    if (!/[*?]/.test(base)) return fs.existsSync(path.join(root, base));
    // 通配在中间（如 src/*/x.js）：截到第一个通配符之前，判那层目录在不在
    const cut = base.slice(0, base.search(/[*?]/)).replace(/\/+$/, "");
    return cut ? fs.existsSync(path.join(root, cut)) : true;
  };
  for (const p of listPaths(db)) {
    for (const rel of p.allowedPaths) {
      if (!existsOnDisk(rel)) items.push({ severity: "warn", code: "STALE_PATH", detail: `${p.id} 的 allowed_path 不存在：${rel}` });
    }
    // 验收命令会不会已经过期：契约冻的是批准那一刻的命令，项目改了 test 脚本它不会自己跟。
    // 但**不能拿字面相等去比**：采集器在 Rust 项目里只认得出 `cargo test`，而契约里写的是
    // `cargo test --workspace --locked`——拿一个更弱的采集结果去指责一份更强的契约，
    // 结果就是 7 条 Path 全报 drift（假警报，这次就是这么来的）。
    // 判据改成「命令签名」：取前两个非开关 token（cargo test / npm test / node --test / git diff）。
    // 只要有一条契约命令的签名还能被采到，就说明这条契约仍然跑得动。
    if (p.status === "approved" && p.testCmds?.length) {
      const now = detectTestCmds(root);
      const sig = (cmd) => {
        const parts = String(cmd ?? "").trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return "";
        const sub = parts.slice(1).find((x) => !x.startsWith("-"));
        return sub ? `${parts[0]} ${sub}` : parts[0];
      };
      const detectedSigs = new Set(now.cmds.map(sig));
      const stale = detectedSigs.size ? !p.testCmds.some((c) => detectedSigs.has(sig(c))) : false;
      if (stale) {
        items.push({
          severity: "warn",
          code: "TEST_CMD_DRIFT",
          pathId: p.id,
          detail: `${p.id} 冻结的命令是 ${p.testCmds.join(" / ")}，项目现在采到的是 ${now.cmds.join(" / ")}——两者对不上号，收口时可能跑一条已不存在的命令（控制台点「重采验收命令」可更新）`,
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
  // 发布说"留下了可回滚点"，那就得真的能 checkout 回去。
  // 记了 tag 却查不到（被删、被打错名字、或换了机器），等于回滚点已经没了，
  // 而发布记录还在那儿说 ship 成功——这是最容易在出事那天才发现的谎（T-114）。
  if (h) {
    for (const r of db.prepare("SELECT id, title, git_tag, git_sha FROM releases WHERE status='shipped'").all()) {
      if (!r.git_tag) {
        items.push({ severity: "error", code: "RELEASE_NO_TAG", detail: `${r.id}「${r.title}」标记已发布，但没记任何 tag（回滚点不存在）` });
        continue;
      }
      let exists = true;
      try {
        git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${r.git_tag}`]);
      } catch {
        exists = false;
      }
      if (!exists) {
        items.push({
          severity: "error",
          code: "RELEASE_TAG_MISSING",
          detail: `${r.id} 记的 tag ${r.git_tag} 在 git 里查不到：回滚点已经没了，但发布记录还说发布了。要么把 tag 补回来（git tag -a ${r.git_tag} -m "${r.id} ${r.title}" ${String(r.git_sha ?? "").slice(0, 8)}），要么把这条发布的记录改对`,
        });
      }
    }
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
    if (!uncovered.length) continue;
    // 这条需求还有没有在做的活：有任务没结束，或有验收没被任何任务认领。
    const mine = tasks.filter((t) => t.requirement_id === r.id);
    const pending = mine.some((t) => !["done", "abandoned"].includes(t.status));
    const claimed = new Set(mine.flatMap((t) => t.acceptance.map((a) => a.deriveFrom)));
    const openAcceptance = r.acceptance.map((_, i) => i).filter((i) => !claimed.has(i));
    if (!pending && !openAcceptance.length) {
      // 活已经干完了：Path 多半被复用给了别的需求。这是历史，不是待办——
      // 报成 error 只会让 doctor 常红，人就开始无视它（真问题时也就看不见了）。
      out.push({
        severity: "note",
        code: "ACCEPTANCE_PATH_MOVED",
        requirementId: r.id,
        detail: `${r.id} 的活已经做完，但它现在没有自己的已批准 Path（很可能被复用给了别的需求）。要给它开新任务时先新建一条 Path；不改也不影响已完成的交付。`,
      });
      continue;
    }
    out.push({
      severity: "error",
      code: "ACCEPTANCE_NOT_IN_CONTRACT",
      requirementId: r.id,
      detail: `${r.id} 批准的验收里有 ${uncovered.join(" / ")}，但没有任何已批准的 Path 冻结了它（现有：${[...new Set(approvedPaths.flatMap((p) => p.testCmds))].join(" / ") || "空"}）`,
    });
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