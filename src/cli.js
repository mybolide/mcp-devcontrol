// devcontrol — CLI 入口：init / run / commit / status / doctor / export / serve / mcp
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { metaGet, metaSet, openDb, dataDir, dbPath } from "./db.js";
import { ask, bugReport, fileClashes, recordEvidence, taskClose, taskRenew, taskCreate, taskClaim } from "./gates.js";
import { git, head, isRepo, toplevel, statusPorcelain, commitFiles, lsFiles } from "./git.js";
import { inScope, sha256 } from "./fingerprint.js";
import { bootstrap } from "./digest.js";
import { cliCommand } from "./nextcmd.js";
import { doctor, exportMarkdown } from "./report.js";
import { createRelease, getRelease, listReleases, planRelease, shipRelease } from "./release.js";
import { FLOWS_REL, flowFromRequirement, flowToRequirement, listFlows, readFlow } from "./flow.js";
import { getReq, getTask, mapTask, listTasks, listReqs, listPaths, listDocs, reqIntake, reqApprove, disciplineStats, logRejection } from "./store.js";
import { hintFor } from "./hints.js";
import { assertionCommand, detectTestCmds } from "./testcmd.js";
import { isVendorPath, vendorIgnores } from "./vendor.js";
import {
  demoteMemory,
  exportMemories,
  generalizeHint,
  listMemories,
  memoryConfig,
  memoryStatus,
  openMemory,
  promoteMemory,
  recallMemories,
  reindexPending,
  rememberAndIndex,
  searchMemories,
  softDeleteMemory,
} from "./memory.js";
import { execCommand } from "./exec.js";
import { startConsole } from "./console.js";
import { runMcp } from "./mcp.js";
import { VERSION } from "./protocol.js";
import { openDb as _openDb } from "./db.js";
import { weekly } from "./weekly.js";
import { renderWeekly } from "./weekly-md.js";
import { installAgentFiles, SKILL_REL } from "./skill.js";


const DEVCONTROL_BIN = fileURLToPath(new URL("../bin/devcontrol.js", import.meta.url));

const mcpServerConfig = (root) => ({
  mcpServers: {
    "devcontrol": { command: process.execPath, args: [DEVCONTROL_BIN, "mcp"], env: { DEVCONTROL_ROOT: root } },
  },
});

const CODEX_SNIPPET = `# ~/.codex/config.toml
[mcp_servers.devcontrol]
command = "${process.execPath}"
args = ["${DEVCONTROL_BIN}", "mcp"]
env = { DEVCONTROL_ROOT = "<项目绝对路径>" }`;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".devcontrol", "coverage", ".next", "target", "vendor"]);

/**
 * 项目根：优先 DEVCONTROL_ROOT，其次 git 顶层，最后 cwd。
 * 但「随便一个目录」不算项目——否则在 $HOME 里启动 MCP 就会就地建库。
 */
export function resolveRoot({ create = false } = {}) {
  if (process.env.DEVCONTROL_ROOT) return process.env.DEVCONTROL_ROOT;
  let root = process.cwd();
  try {
    root = toplevel(process.cwd()) || process.cwd();
  } catch {
    root = process.cwd();
  }
  if (create) return root;
  const initialized = fs.existsSync(path.join(root, ".devcontrol"));
  if (!initialized && !isRepo(root)) {
    throw Object.assign(new Error(`E_NO_ROOT: ${root} 既不是 git 仓库，也没有 .devcontrol/；先跑 devcontrol init`), { code: "E_NO_ROOT" });
  }
  return root;
}

function appendLines(file, lines) {
  const abs = path.join(process.cwd(), file);
  const cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const missing = lines.filter((l) => !cur.split("\n").includes(l));
  if (!missing.length) return false;
  fs.writeFileSync(abs, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, "utf8");
  return true;
}

/**
 * .devcontrol/contracts/ 必须进 git（契约真源），所以 .gitignore 里"整体忽略
 * .devcontrol/"的规则必须去掉：git 不允许在被排除的父目录下再包含文件，
 * 光追加 !.devcontrol/contracts/ 是无效的。只删这一条，其它忽略规则不动。
 */
const BLANKET_DATA_DIR = /^\/?\.devcontrol\/?\*?$/;
function dropBlanketDataDirIgnore(file = ".gitignore") {
  const abs = path.join(process.cwd(), file);
  if (!fs.existsSync(abs)) return false;
  const cur = fs.readFileSync(abs, "utf8");
  const lines = cur.split("\n");
  const kept = lines.filter((l) => !BLANKET_DATA_DIR.test(l.trim()));
  if (kept.length === lines.length) return false;
  fs.writeFileSync(abs, kept.join("\n"), "utf8");
  return true;
}

/**
 * 只保留「还没被 git 跟踪」的忽略条目。
 * 有人特意把 dist/ 提交进仓库时，再忽略它会让 `git add` 直接失败
 * （git 拒绝 add 已被忽略的路径），把正常提交堵死。
 */
function notAlreadyTracked(root, entries) {
  if (!isRepo(root)) return entries;
  let files = [];
  try {
    files = lsFiles(root);
  } catch {
    return entries;
  }
  return entries.filter((entry) => {
    const prefix = entry.replace(/\/$/, "");
    return !files.some((f) => f === prefix || f.startsWith(`${prefix}/`));
  });
}

function writeIfMissing(rel, value) {
  const abs = path.join(process.cwd(), rel);
  if (fs.existsSync(abs)) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return true;
}

/** 已有配置但 DEVCONTROL_ROOT 指向别处（仓库被移动/复制）→ 重写，保留其他 MCP server */
function writeMcpConfig(rel, value, root) {
  const abs = path.join(process.cwd(), rel);
  if (!fs.existsSync(abs)) return writeIfMissing(rel, value) ? "written" : "exists";
  let current;
  try {
    current = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return "invalid"; // 不碰用户手写的坏文件
  }
  const isOpenCode = Boolean(current.mcp);
  const entry = isOpenCode ? current.mcp?.["devcontrol"] : current.mcpServers?.["devcontrol"];
  const currentRoot = isOpenCode ? entry?.environment?.DEVCONTROL_ROOT : entry?.env?.DEVCONTROL_ROOT;
  if (currentRoot && path.resolve(currentRoot) === path.resolve(root)) return "exists";
  if (isOpenCode) {
    current.mcp = { ...(current.mcp ?? {}), "devcontrol": value.mcp["devcontrol"] };
  } else {
    current.mcpServers = { ...(current.mcpServers ?? {}), "devcontrol": value.mcpServers["devcontrol"] };
  }
  fs.writeFileSync(abs, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  return "updated";
}

export function cmdInit(args) {
  const root = resolveRoot({ create: true });
  const weak = args.includes("--weak");
  const gitMode = isRepo(root);
  if (!gitMode && !weak) {
    // 不是用法写错，是环境不满足：退出码 1（被拒），不是 2（用法）
    return failCli(
      "这里不是 git 仓库。加 --weak 使用弱模式（只跑验收，没有提交归属与 scope 校验）",
      "E_NOT_REPO",
      null,
      1,
    );
    return 1;
  }
  process.chdir(root);
  fs.mkdirSync(path.join(dataDir(root), "runs"), { recursive: true });
  fs.mkdirSync(path.join(dataDir(root), "contracts"), { recursive: true });
  const unignored = dropBlanketDataDirIgnore();
  // 依赖/构建产物默认忽略——但项目特意提交过的（dist/ 进了 git）不能忽略，
  // 否则 git 拒绝再 add，反而把正常提交挡住。
  appendLines(".gitignore", [
    ...notAlreadyTracked(root, vendorIgnores(root)),
    ".devcontrol/state.db*",
    ".devcontrol/memory.db*",
    ".devcontrol/settings.json",
    ".devcontrol/runs/",
    ".devcontrol/console.lock",
    ".devcontrol/console.json",
  ]);
  appendLines(".gitattributes", ["* text=auto eol=lf"]);
  const noMcp = args.includes("--no-mcp");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? new Set(String(args[onlyIdx + 1] ?? "").split(",").filter(Boolean)) : null;

  const db = openDb(root);
  metaSet(db, "mode", gitMode ? "git" : "weak");
  // 命令从「项目现在的样子」采一次；之后项目变了，Owner 在控制台点「重采验收命令」
  const detected = detectTestCmds(root);
  const testCmds = detected.cmds;
  let created = 0;
  // 默认只生成一条覆盖全项目的根 Path（"."）：改实现 + 补测试是同一个正常动作，
  // 按顶层目录切会把它拆成两个任务、还得串依赖，人反而要多批一次。
  // 想收窄成目录级 Path 时用 --only src,test。
  const dirs = only
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && only.has(e.name))
        .map((e) => e.name)
    : ["."];
  for (const dir of dirs) {
    const exists = db.prepare("SELECT 1 FROM paths WHERE allowed_paths_json=?").get(JSON.stringify([dir]));
    if (exists) continue;
    // 计数器可能因为早期手工插库或旧 bug 落后，撞号就往下找空号，别用裸 SQLite 错误崩掉
    const usedP = new Set(db.prepare("SELECT id FROM paths").all().map((r) => Number(String(r.id).replace(/\D/g, "")) || 0));
    let n = Number(db.prepare("SELECT value FROM meta WHERE key='counter:P'").get()?.value ?? 0);
    do {
      n += 1;
    } while (usedP.has(n));
    db.prepare("INSERT INTO paths(id,allowed_paths_json,allow_new_files,budget_lines,test_cmds_json,status) VALUES(?,?,?,?,?,?)").run(
      `P-${String(n).padStart(3, "0")}`,
      JSON.stringify([dir]),
      0,
      1200,
      JSON.stringify(testCmds),
      "draft",
    );
    db.prepare("INSERT INTO meta(key,value) VALUES('counter:P',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
    created += 1;
  }
  const label = (v) => ({ written: "已写", updated: "已按新路径更新", exists: "已存在", invalid: "已存在但解析失败，未改动", skipped: "跳过（--no-mcp）" })[v] ?? v;
  const wroteMcp = noMcp ? "skipped" : writeMcpConfig(".mcp.json", mcpServerConfig(root), root);
  const wroteCursor = noMcp ? "skipped" : writeMcpConfig(".cursor/mcp.json", mcpServerConfig(root), root);
  const wroteOpencode = noMcp
    ? "skipped"
    : writeMcpConfig(
        "opencode.json",
        { mcp: { "devcontrol": { type: "local", command: [process.execPath, DEVCONTROL_BIN, "mcp"], environment: { DEVCONTROL_ROOT: root } } } },
        root,
      );
  // Agent 侧安装物：规范 Skill 只有一份，其余都是指针（照 v5 的做法，避免多份内容各自漂移）
  const agentFiles = installAgentFiles(root, { noMcp });
  // init 自己写的配置要自己提交：否则第一次 close 会被 E_DIRTY_SCOPE 拦住
  const managed = [
    ".gitignore",
    ".gitattributes",
    ...Object.keys(agentFiles),
    ...(noMcp ? [] : [".mcp.json", ".cursor/mcp.json", "opencode.json"]),
  ].filter((f) => fs.existsSync(path.join(root, f)));
  let initCommit = null;
  try {
    initCommit = commitFiles(root, managed, "chore(devcontrol): init");
  } catch {
    /* 没有可提交改动 */
  }
  console.log(`devcontrol init 完成：
- 数据目录 .devcontrol/（state.db / contracts / runs）
- 模式：${gitMode ? "git（完整门禁）" : "weak（无 git：只跑验收，无归属校验）"}
${unignored ? "- .gitignore：已移除整体忽略 .devcontrol/ 的规则（契约必须能进 git）\n" : ""}- Path 草稿 ${created} 条（都还是 draft，需要 Owner 批准）
- 客户端配置：.mcp.json ${label(wroteMcp)} / .cursor/mcp.json ${label(wroteCursor)} / opencode.json ${label(wroteOpencode)}
- Agent 说明：${Object.keys(agentFiles).join(" / ")}（${SKILL_REL} 是规范，其余是指针）
${noMcp ? "" : "- 控制台：随 MCP 连接自动启动并复用（Owner 也可以手动 devcontrol serve）\n"}- 托管文件：${initCommit ? `已提交 chore(devcontrol): init @ ${initCommit.slice(0, 8)}` : "无变化"}
${noMcp ? "- 纯 CLI 模式：没有注册 MCP，Agent 直接用 devcontrol status / commit / close；需要控制台时自己 devcontrol serve" : `- Codex 需要手动加：\n${CODEX_SNIPPET}`}`);
  return 0;
}

export async function cmdRun(args) {
  const idx = args.indexOf("--");
  const command = idx >= 0 ? args.slice(idx + 1).join(" ") : args.join(" ");
  if (!command) {
    return failCli("用法：devcontrol run -- <command>", "E_USAGE");
  }
  const root = resolveRoot();
  const db = openDb(root);
  const actor = process.env.DEVCONTROL_ACTOR || "agent";
  // 有在办任务时，这条命令的结果就是「测试证据」：内核只记账，不替项目跑测试。
  const doing = db.prepare("SELECT id FROM tasks WHERE status='doing' AND claimed_by=? AND closing_token IS NULL").all(actor);
  const result = await execCommand(root, command);
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (doing.length === 1) {
    const t = getTask(db, doing[0].id);
    const ev = recordEvidence(db, root, { taskId: t.id, command, result, scope: t.scope });
    console.log(`\n[devcontrol] exit ${result.exit} · ${result.durationMs}ms · 已记为 ${t.id} 的证据 ${ev.id}`);
  } else {
    console.log(`\n[devcontrol] exit ${result.exit} · ${result.durationMs}ms`);
    if (doing.length === 0) console.log("[devcontrol] 没有在办任务，这条结果没有记为证据（先 devcontrol task claim）");
  }
  return result.exit;
}

/**
 * 统一的失败出口。
 *
 * 为什么必须有它：成功是 stdout 上的 JSON，失败却曾经只是 stderr 上一行纯文本——
 * Agent 想分支处理就得先撞一遍。约定很简单：**失败也是 JSON，`ok:false` 且必带 code**。
 * exit 2 留给「用法写错了」，1 留给「动作被拒」。
 */
/**
 * 这次失败要能算进 stats 的「被拦」，否则那个数永远是 0——而它正是产品自证
 * 「内核到底有没有在起作用」的唯一指标（T-097）。
 *
 * 两类分开记：env-only 是「补一步就好」（忘了跑测试、工作树脏），不算纪律问题。
 * 记账本身失败不能把错误提示也弄丢，所以整块吞异常。
 */
function noteRejection(code) {
  try {
    const root = resolveRoot();
    if (!fs.existsSync(dbPath(root))) return; // 还没有项目库，别为了记账凭空建一个
    logRejection(openDb(root), process.env.DEVCONTROL_ACTOR, code);
  } catch {
    /* 记不上就算了 */
  }
}

function failCli(message, code = "E_USAGE", data = null, exit = 2) {
  noteRejection(code);
  const hint = hintFor({ code });
  console.log(JSON.stringify({ ok: false, code, message, data, hint }, null, 2));
  console.error(`${code}: ${message}`);
  if (hint) console.error(`  → ${hint}`);
  if (data) console.error(JSON.stringify(data, null, 2));
  return exit;
}

export function cmdCommit(args) {
  const root = resolveRoot();
  const msgIdx = args.indexOf("-m");
  const message = msgIdx >= 0 ? args[msgIdx + 1] : null;
  if (!message) {
    return failCli('用法：devcontrol commit -m "<message>" [--actor name] [--take-over]', "E_USAGE");
    return 2;
  }
  const actorIdx = args.indexOf("--actor");
  const actor = actorIdx >= 0 ? args[actorIdx + 1] : process.env.DEVCONTROL_ACTOR || "agent";
  const db = openDb(root);
  if (metaGet(db, "mode") === "weak") {
    return failCli("弱模式没有 git，不能提交；直接把改动留在工作树里，然后 devcontrol close", "E_WEAK_NO_GIT", null, 1);
    return 1;
  }
  const doing = db.prepare("SELECT * FROM tasks WHERE status='doing' AND claimed_by=? AND closing_token IS NULL").all(actor);
  if (!doing.length) {
    return failCli(`${actor} 手上没有在办任务，先 task.claim`, "E_NO_TASK", null, 1);
    return 1;
  }
  if (doing.length > 1) {
    return failCli(`${actor} 有多个在办任务：${doing.map((t) => t.id).join(", ")}`, "E_WIP_LIMIT", { holding: doing.map((t) => t.id) }, 1);
    return 1;
  }
  const task = getTask(db, doing[0].id);
  taskRenew(db, root, { id: task.id }, actor); // 写操作续租（契约 §5.1）
  // 未跟踪的依赖/构建产物不是交付物：既不提交（scope="." 时），也不算 scope 违规（scope="src" 时）。
  // 已经被 git 跟踪的照常参与——那是有人特意提交的，内核不翻案。
  const trackedSet = new Set(
    statusPorcelain(root, ["--untracked-files=no"])
      .split("\n")
      .filter((l) => l.length > 3)
      .map((l) => {
        const rest = l.slice(3).trim();
        const arrow = rest.lastIndexOf(" -> ");
        return (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, "");
      })
      .filter(Boolean),
  );
  const raw = statusPorcelain(root, ["--untracked-files=all"])
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => {
      const rest = l.slice(3).trim();
      const arrow = rest.lastIndexOf(" -> ");
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, "");
    })
    .filter(Boolean);
  const dirty = raw.filter((f) => !(isVendorPath(f, root) && !trackedSet.has(f)));
  const skipped = raw.filter((f) => isVendorPath(f, root) && !trackedSet.has(f));
  if (skipped.length) {
    console.error(`跳过 ${skipped.length} 个依赖/构建产物（不是交付物）：${skipped.slice(0, 3).join("、")}${skipped.length > 3 ? " …" : ""}`);
  }
  const mine = dirty.filter((f) => inScope(f, task.scope));
  const foreign = dirty.filter((f) => !inScope(f, task.scope) && !f.startsWith(".devcontrol/"));
  if (foreign.length) {
    return failCli(
      `以下改动不在 ${task.id} 的 scope 内（scope=${task.scope.join(",") || "."}）：${foreign.slice(0, 8).join("、")}${foreign.length > 8 ? ` …共 ${foreign.length} 个` : ""}`,
      "E_SCOPE_VIOLATION",
      { taskId: task.id, scope: task.scope, files: foreign },
      1,
    );
    return 1;
  }
  if (!mine.length) {
    return failCli(
      `scope 内没有可提交的改动（scope=${task.scope.join(",") || "."}）`,
      "E_NO_DELIVERY",
      { taskId: task.id, scope: task.scope },
      1,
    );
    return 1;
  }
  // 这批改动是不是我干的？接活那一刻工作区里就已经脏的，不是我写的。
  // 接手别人的半成品很正常，但把别人的活记在自己 Task-Id 下，归属就说不清了（T-095）。
  const inherited = (() => {
    try {
      return JSON.parse(metaGet(db, `dirty-at-claim:${task.id}`) ?? "[]").filter((f) => mine.includes(f));
    } catch {
      return [];
    }
  })();
  if (inherited.length && !args.includes("--take-over")) {
    return failCli(
      `${inherited.length} 个文件在你接活之前就有改动（可能是上一任留下的）：${inherited.slice(0, 5).join("、")}${inherited.length > 5 ? ` …共 ${inherited.length} 个` : ""}。确认要一起提交就加 --take-over`,
      "E_INHERITED_CHANGE",
      { taskId: task.id, files: inherited },
      1,
    );
  }
  if (inherited.length) {
    console.error(`接管 ${inherited.length} 个接活前就存在的改动：${inherited.slice(0, 5).join("、")}`);
  }

  // 提交前先看一眼：这些文件有没有已经被别的在办任务改过（真撞车，不是共享目录那种提醒）
  const clashes = fileClashes(db, root, task.id, mine);
  if (clashes.length) {
    const who = [...new Set(clashes.map((c) => c.task))].join("、");
    return failCli(
      `和 ${who} 改了同一个文件：${clashes.slice(0, 3).map((c) => c.file).join("、")}`,
      "E_FILE_OVERLAP",
      { files: clashes.map((c) => c.file), tasks: [...new Set(clashes.map((c) => c.task))] },
      1,
    );
  }
  const body = `${message}\n\nTask-Id: ${task.id}\nDevControl-Base: ${task.base_head}`;
  const sha = commitFiles(root, mine, body, { author: actor });
  console.log(`${sha.slice(0, 8)}  ${task.id}  ${mine.length} 个文件`);
  return 0;
}

/** 纪律三数：内核有没有真的拦住、返工、被绕过 */
/**
 * 控制台在不在跑、在哪个端口。
 *
 * 读 meta 文件而不是 HTTP 探测：status 是高频命令，为了一个字段等 400ms 不值当。
 * pid 死了就当作没起（进程崩溃留下的文件不能当成活的）。
 */
function liveConsole(root) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir(root), "console.json"), "utf8"));
    process.kill(meta.pid, 0);
    return `http://127.0.0.1:${meta.port}/`;
  } catch {
    return null;
  }
}

export function cmdStats() {
  const root = resolveRoot();
  const db = openDb(root);
  const s = disciplineStats(db);
  const tail = s.envOnly ? `（另有 ${s.envOnly} 次缺证据/工作树脏这类补一步就好）` : "";
  console.log(`被拦 ${s.blocked} 次${tail} · 返工 ${s.rework} 轮 · 绕过 ${s.bypassed} 次 · 已完成 ${s.done} 个任务`);
  return 0;
}
/**
 * 周报：把这一周的事件流说成一句人话，再摊成三张表。
 * 默认出 markdown（能直接贴进周报文档），--json 出原始数字（给别的工具接）。
 */
export function cmdReport(args = []) {
  const root = resolveRoot();
  const db = openDb(root);
  const at = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const rawDays = at("days");
  const days = rawDays === undefined ? 7 : Number(rawDays);
  if (!Number.isFinite(days) || days <= 0) {
    return failCli(`--days 要是正数，收到的是 ${JSON.stringify(rawDays)}`, "E_USAGE");
  }
  const w = weekly(db, { days });
  if (args.includes("--json")) {
    console.log(JSON.stringify(w, null, 2));
    return 0;
  }
  process.stdout.write(renderWeekly(w, { title: at("title") ?? "周报" }));
  return 0;
}


export function cmdFlow(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const sub = args[0] ?? "list";
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (sub === "list") {
    const rows = listFlows(root);
    if (!rows.length) {
      console.log("还没有 flow 模板。把一个做过的需求沉淀成模板：devcontrol flow save <名字> --from FR-001");
      return 0;
    }
    for (const r of rows) {
      if (r.error) console.log(`${r.name}  ✗ ${r.error}`);
      else console.log(`${r.name.padEnd(20)} ${r.acceptance} 条验收 · ${r.tasks} 个任务  ${r.description}`);
    }
    return 0;
  }
  if (sub === "show") {
    console.log(JSON.stringify(readFlow(args[1], root), null, 2));
    return 0;
  }
  if (sub === "save") {
    const name = args[1];
    const from = flag("from");
    if (!name || !from) {
      return failCli("用法：devcontrol flow save <名字> --from FR-001", "E_USAGE");
      return 2;
    }
    const flow = flowFromRequirement(db, from, name, root);
    console.log(`已沉淀 flow ${flow.name}：${flow.acceptance.length} 条验收 · ${flow.tasks.length} 个任务 → ${FLOWS_REL}/${flow.name}.json`);
    console.log("记得把它 commit 进仓库——它是团队的做法，不是机器状态。");
    return 0;
  }
  if (sub === "apply") {
    const name = args[1];
    const { requirementId, flow } = flowToRequirement(db, root, name);
    console.log(`已按 flow ${name} 建需求 ${requirementId}（草稿）。`);
    console.log("下一步：Owner 在控制台批准 → Agent 按模板拆任务：");
    flow.tasks.forEach((t, i) => {
      const dep = t.dependsOn.length ? `  依赖 ${t.dependsOn.map((n) => n + 1).join(",")}` : "";
      console.log(`  ${i + 1}. ${t.title}  scope=${(t.scope ?? []).join(",") || "-"}${dep}`);
    });
    return 0;
  }
  return failCli("用法：devcontrol flow <list|show|save|apply> ...", "E_USAGE");
  return 2;
}

export function cmdTask(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const every = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
  const actor = flag("actor") ?? (process.env.DEVCONTROL_ACTOR || "agent");
  const sub = args[0];
  if (sub === "create") {
    const req = flag("req") ?? flag("requirement");
    const pathId = flag("path");
    const title = flag("title");
    if (!req || !pathId || !title) {
      return failCli(
        '用法：devcontrol task create --req FR-001 --path P-001 --title "一言说清" [--kind fix] [--scope src,test] [--accept "npm test :: exit==0"] [--depends T-001[,T-002]]',
        "E_USAGE",
      );
    }
    const accepts = every("accept");
    const deriveFlag = flag("derive");
    // deriveFrom 指「这条断言对应需求验收里的第几条」。默认按命令自己匹配，
    // 否则一次 --accept 两条（测试 + 构建）会双双写成 0，覆盖率永远认为第二条没人管：
    // 内核随后一直让 Agent 「去建任务覆盖 npm run build」，而那条任务明明已经做了。
    const reqRow = db.prepare("SELECT acceptance_json FROM requirements WHERE id=?").get(req);
    const reqAcceptance = reqRow ? JSON.parse(reqRow.acceptance_json) : [];
    // 默认验收不能写死 npm test：这是给多语言用的内核，Go 项目的默认值应该是
    // 它自己契约里的第一条命令（go test ./...），否则建任务在第一句就失败。
    const pathRow = db.prepare("SELECT test_cmds_json FROM paths WHERE id=?").get(pathId);
    const pathCmds = pathRow ? JSON.parse(pathRow.test_cmds_json) : [];
    const fallback = pathCmds.length ? [`${pathCmds[0]} :: exit==0`] : [];
    const acceptance = (accepts.length ? accepts : fallback).map((assertion) => {
      if (deriveFlag !== undefined) return { deriveFrom: Number(deriveFlag), assertion };
      const cmd = assertionCommand(assertion);
      const idx = reqAcceptance.findIndex((a) => assertionCommand(a) === cmd);
      return { deriveFrom: idx >= 0 ? idx : 0, assertion };
    });
    // scope：--scope 可重复，也可逗号分隔。早先只取最后一段，多写一次就把前一段悄悄吃掉（T-087）
    const scopeList = every("scope")
      .flatMap((v) => String(v).split(","))
      .map((s) => s.trim())
      .filter(Boolean);
    const scope = scopeList.length ? scopeList : undefined;
    // 依赖：MCP 侧叫 dependsOn，CLI 这边用 --depends（可重复，也可逗号分隔）——纯 CLI 用户也要能表达「前端等后端」
    const dependsOn = every("depends")
      .flatMap((v) => String(v).split(","))
      .map((s) => s.trim())
      .filter(Boolean);
    const task = taskCreate(db, root, { requirementId: req, pathId, kind: flag("kind") ?? "feature", title, scope, acceptance, dependsOn }, actor);
    console.log(`${task.id}  已建  ${task.title}`);
    console.log(`scope: ${(task.scope ?? []).join(", ")}`);
    if (task.dependsOn?.length) console.log(`前置: ${task.dependsOn.join(", ")}`);
    return 0;
  }
  if (sub === "claim") {
    const id = args.slice(1).find((a) => /^T-\d+$/.test(a));
    if (!id) {
      return failCli("用法：devcontrol task claim T-00x [--actor name]", "E_USAGE");
      return 2;
    }
    const claimed = taskClaim(db, root, { id }, actor);
    console.log(`${claimed.id} 已领取（租约到 ${claimed.claimExpiresAt}）`);
    console.log(`scope: ${claimed.scope.join(", ")}`);
    for (const cmd of claimed.testCmds) console.log(`验收命令: ${cmd}`);
    // 规范也印出来：开工时就该知道边界，而不是收口被拦才第一次听说
    if (claimed.standards?.rules?.length) {
      console.log(`规范（${claimed.standards.enforced?.length ? `内核会拦：${claimed.standards.enforced.join("、")}；` : ""}其余靠自觉）：`);
      for (const st of claimed.standards.rules) console.log(`  · ${st.text}`);
    }
    return 0;
  }
  if (sub === "list") {
    // 列宽要容得下最长的状态（abandoned = 9），否则 "abandonedfeature" 粘成一坨
    for (const t of db.prepare("SELECT id,status,kind,title FROM tasks ORDER BY id").all()) {
      console.log(`${t.id}  ${t.status.padEnd(10)}${t.kind.padEnd(9)}${t.title}`);
    }
    return 0;
  }
  return failCli("用法：devcontrol task <create|claim|list> ...", "E_USAGE");
  return 2;
}

export function cmdNext() {
  const root = resolveRoot();
  const db = openDb(root);
  const digest = bootstrap(db, root);
  if (!digest.next) return 0;
  console.log(`${digest.next.action}  ${digest.next.why ?? ""}`);
  // 纯 CLI 用户要的不是 MCP 的参数名，是一条能粘进终端的命令。
  // 内核知道两边怎么对应，就别让人自己翻（T-102）。
  const cmd = digest.next.cli ?? cliCommand(digest.next.action, digest.next.args);
  if (cmd) {
    console.log(`\n${cmd}`);
  } else if (digest.next.steps?.length) {
    // 有些步骤没有「一条命令」可给（写代码就是写代码）。
    // 这时把顺序摆清楚，比硬编一条跑不通的命令诚实。
    console.log("\n按顺序：");
    digest.next.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  } else if (Object.keys(digest.next.args ?? {}).length) {
    console.log(JSON.stringify(digest.next.args, null, 2));
  }
  return 0;
}

export function cmdRenew(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const actorIdx = args.indexOf("--actor");
  const actor = actorIdx >= 0 ? args[actorIdx + 1] : process.env.DEVCONTROL_ACTOR || "agent";
  const explicit = args.find((a) => /^T-\d+$/.test(a));
  const held = db.prepare("SELECT id FROM tasks WHERE status='doing' AND claimed_by=? AND closing_token IS NULL").get(actor);
  const id = explicit ?? held?.id;
  if (!id) {
    return failCli(`${actor} 手上没有在办任务`, "E_NO_TASK", null, 1);
    return 1;
  }
  const res = taskRenew(db, root, { id }, actor);
  console.log(`${res.id} 租期续到 ${res.claimExpiresAt}`);
  return 0;
}

export async function cmdClose(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const flagValue = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const actor = flagValue("--actor") ?? process.env.DEVCONTROL_ACTOR ?? "agent";
  const resolvedBy = flagValue("--resolved-by");
  const consumed = new Set([actor, resolvedBy].filter(Boolean));
  let id = args.find((a) => !a.startsWith("--") && !consumed.has(a));
  if (!id) {
    const doing = db.prepare("SELECT id FROM tasks WHERE status='doing' AND claimed_by=? AND closing_token IS NULL").all(actor);
    if (doing.length !== 1) {
      return doing.length
        ? failCli(`${actor} 有多个在办任务，请指明任务号`, "E_WIP_LIMIT", { holding: doing.map((t) => t.id) }, 1)
        : failCli(`${actor} 手上没有在办任务`, "E_NO_TASK", null, 1);
      return 1;
    }
    id = doing[0].id;
  }
  try {
    // 进度走 stderr：stdout 必须可以整段 JSON.parse，进度只是给人看的
    const tty = process.stderr.isTTY;
    const onProgress = ({ stage, detail, elapsedMs }) => {
      const secs = `${Math.round(elapsedMs / 100) / 10}s`;
      if (!tty) {
        process.stderr.write(`[devcontrol ${secs}] ${detail}\n`);
        return;
      }
      // TTY 下原地刷新，一行看完整程；里程碑（开跑/跑完/成功/失败）各占一行；
      // 心跳只在原地改那一行，不刷屏。
      const milestone = stage === "assert" || stage === "assert-done" || stage === "done" || stage === "failed";
      process.stderr.write(`\r\x1b[2K[devcontrol ${secs}] ${detail}`);
      if (milestone) process.stderr.write("\n");
    };
    const res = await taskClose(db, root, { id, resolvedBy }, { onProgress });
    if (tty) process.stderr.write("\n");
    // 规范对照只走 stderr（人读）：内核报事实，判不判由人。
    // stdout 仍然是一整段 JSON，observations 在里面，脚本能自己用。
    if (res.observations?.length) {
      process.stderr.write("\n规范对照（内核只报事实，判断在你）：\n");
      for (const o of res.observations) process.stderr.write(`  · ${o.detail}\n`);
      process.stderr.write("  要打回：控制台「任务」里 reopen，或者核一下是不是该拆得更小。\n");
    }
    // 成功也带 ok:true：脚本只要看一个字段就知道结果，不用猜"有没有 ok 字段"
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    return 0;
  } catch (error) {
    // 交给 main() 统一收口：失败的 JSON 也走 stdout，人话提示走 stderr
    throw error;
  }
}

export async function cmdStatus() {
  const root = resolveRoot();
  const db = openDb(root);
  const doing = db.prepare("SELECT * FROM tasks WHERE status='doing' ORDER BY id LIMIT 1").get();
  const memory = await recallMemories(root, doing ? mapTask(doing) : null);
  console.log(JSON.stringify(bootstrap(db, root, { console: liveConsole(root), memories: memory.memories }), null, 2));
  return 0;
}

export async function cmdMemory(args) {
  const sub = args[0] ?? "status";
  const cfg = memoryConfig(process.env, resolveRoot());
  const flag = (name, fallback = undefined) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  if (sub === "status") {
    console.log(JSON.stringify(memoryStatus(cfg), null, 2));
    return 0;
  }
  if (sub === "list") {
    const kind = flag("kind", args[1] && !args[1].startsWith("--") ? args[1] : null);
    const status = flag("status", null);
    for (const m of listMemories(cfg, Number(flag("limit", 20)), kind, status)) {
      console.log(`${m.id}  [${m.kind}${m.status === "candidate" ? " · 候选" : ""}${m.project ? ` · ${m.project}` : ""}]  ${m.title}`);
      console.log(`        ${m.body.split("\n")[0].slice(0, 120)}`);
    }
    return 0;
  }
  if (sub === "search") {
    const query = args.slice(1).filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!query) {
      return failCli('用法：devcontrol memory search "<关键词>"', "E_USAGE");
      return 2;
    }
    const mem = openMemory(cfg);
    try {
      const { memories, mode, degraded } = await searchMemories(cfg, mem, { query, limit: Number(flag("limit", 5)) });
      if (!memories.length) console.log("没有命中");
      for (const m of memories) {
        console.log(`${m.id}${m.score ? ` (${m.score})` : ""}  [${m.kind}${m.project ? ` · ${m.project}` : ""}]  ${m.title}`);
        console.log(`        ${m.body.replace(/\n/g, "\n        ")}`);
      }
      if (mode === "keyword") console.log(`\n[降级：向量检索不可用，用的是关键词。${degraded ?? ""}]`);
    } finally {
      mem.close();
    }
    return 0;
  }
  if (sub === "add") {
    const title = args[1] && !args[1].startsWith("--") ? args[1] : flag("title");
    const body = flag("body");
    if (!title || !body) {
      return failCli('用法：devcontrol memory add "标题" --body "现象/原因/解法" [--kind pitfall|howto|decision|preference|snippet|note] [--tags a,b]', "E_USAGE");
      return 2;
    }
    const res = await rememberAndIndex(
      {
        title,
        body,
        kind: flag("kind", "note"),
        tags: String(flag("tags", "")).split(",").map((s) => s.trim()).filter(Boolean),
        project: flag("project", null),
        source: "owner",
      },
      cfg,
    );
    console.log(JSON.stringify(res));
    if (res.status === "candidate") console.log(`\n${generalizeHint(res.reasons ?? []).ask}`);
    return res.recorded ? 0 : 1;
  }
  if (sub === "export") {
    process.stdout.write(`${exportMemories(cfg, Number(flag("limit", 500)))}\n`);
    return 0;
  }
  if (sub === "reindex") {
    const mem = openMemory(cfg);
    try {
      console.log(JSON.stringify(await reindexPending(mem, cfg)));
    } finally {
      mem.close();
    }
    return 0;
  }
  if (sub === "promote" || sub === "demote") {
    if (!args[1]) {
      return failCli(`用法：devcontrol memory ${sub} M-xxxxxxxx`, "E_USAGE");
      return 2;
    }
    if (sub === "promote") {
      console.log(JSON.stringify(await promoteMemory(cfg, args[1])));
    } else {
      console.log(demoteMemory(cfg, args[1]) ? "已转回候选（不再参与召回）" : "没有这条记录");
    }
    return 0;
  }
  if (sub === "delete") {
    if (!args[1]) {
      return failCli("用法：devcontrol memory delete M-xxxxxxxx", "E_USAGE");
      return 2;
    }
    console.log(softDeleteMemory(cfg, args[1]) ? "已软删除" : "没有这条记录");
    return 0;
  }
  return failCli("未知子命令：status | list | search | add | export | reindex | promote | demote | delete", "E_USAGE");
  return 2;
}

export function cmdDoctor() {
  const root = resolveRoot();
  const db = openDb(root);
  const items = doctor(db, root);
  if (!items.length) console.log("doctor: 一切正常");
  // 三档要分清楚：error=坏了必须处理，warn=纪律上的提醒，info=环境状况（不是你的错，也不用修）
  const LABEL = { error: "ERROR", warn: "warn ", info: "note " };
  for (const it of items) {
    // 一行一个：先标出「哪条」，再说「怎么了」。不写编号的话，十条一模一样的话看不出该动哪一条。
    const who = it.taskId ?? it.requirementId ?? it.pathId ?? "";
    console.log(`${LABEL[it.severity] ?? "warn "} ${it.code}${who ? ` ${who}` : ""} ${it.detail}`);
  }
  return items.some((i) => i.severity === "error") ? 1 : 0;
}

export function cmdDoc(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const sub = args[0] ?? "list";
  if (sub === "add") {
    const rel = args[1];
    if (!rel) {
      return failCli("用法：devcontrol doc add <相对路径> [--title 标题] [--kind spec|adr|guide]", "E_USAGE");
      return 2;
    }
    const flag = (name) => {
      const i = args.indexOf(`--${name}`);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const res = reqIntake(db, root, { type: "doc", path: rel, title: flag("title"), kind: flag("kind") ?? "spec" });
    console.log(JSON.stringify(res));
    return 0;
  }
  if (sub === "list") {
    const drift = doctor(db, root).filter((i) => i.code === "DOC_DRIFT");
    const docs = listDocs(db);
    if (!docs.length) console.log("还没有登记的文档（devcontrol doc add <文件>）");
    for (const d of docs) {
      const hit = drift.find((x) => String(x.detail).includes(d.path));
      console.log(`${d.id}  ${d.path}  ${hit ? `漂移：${hit.detail}` : "OK"}`);
    }
    return 0;
  }
  return failCli("未知子命令：add | list", "E_USAGE");
  return 2;
}

/**
 * devcontrol intake "标题" --accept "npm test :: exit==0" [--goal …] [--accept …]
 *
 * 为什么要有：README 把 --no-mcp 写成和 MCP 并列的正式模式，但这条路第 1 步就断了——
 * 需求只能从控制台收，而 --no-mcp 的项目里可能根本没有控制台在跑（T-104）。
 *
 * 它是 Owner 的动作：Agent 不该用。内核不设密码（那是假安全感），
 * 但会把「谁、从哪个入口」记进事件流——控制台和周报里看得见。
 */
export function cmdIntake(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const every = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
  const title = flag("title") ?? args.find((a) => !a.startsWith("--"));
  const acceptance = every("accept");
  if (!title || !acceptance.length) {
    return failCli(
      '用法：devcontrol intake "一句话说清要什么" --accept "npm test :: exit==0" [--accept "npm run build :: exit==0"] [--goal "为什么做"]',
      "E_USAGE",
    );
  }
  try {
    const res = reqIntake(db, root, {
      type: "requirement",
      title,
      goal: flag("goal"),
      acceptance,
      channel: "cli",
    });
    console.log(`${res.id}  已收件（草稿）：${title}`);
    console.log(`验收 ${acceptance.length} 条：`);
    for (const a of acceptance) console.log(`  · ${a}`);
    console.log(`\n下一步：devcontrol approve ${res.id} --path <P-00x>（用 devcontrol status 看有哪些 Path）`);
    return 0;
  } catch (error) {
    return failCli(error.message, error.code ?? "E_ERROR", error.data ?? null, 1);
  }
}

/**
 * devcontrol approve FR-001 --path P-001
 *
 * 批准 = 冻结契约。这是这个产品里最重的一次点击：之后 Agent 改不了验收、改不了命令。
 * 所以它在这里仍然是「人的动作」——命令行上能敲，但事件流记 channel=cli，
 * 谁在什么时候从终端批的，事后查得到。
 */
export function cmdApprove(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const requirementId = flag("req") ?? flag("requirementId") ?? args.find((a) => /^FR-\d+$/.test(a));
  const pathId = flag("path") ?? flag("pathId") ?? args.find((a) => /^P-\d+$/.test(a));
  if (!requirementId || !pathId) {
    const pending = listReqs(db).filter((r) => r.status === "draft");
    const paths = listPaths(db).filter((p) => p.status === "draft" || p.status === "approved");
    return failCli(
      `用法：devcontrol approve FR-001 --path P-001${
        pending.length ? `\n待批准的需求：${pending.map((r) => r.id).join("、")}` : "\n（当前没有待批准的需求：devcontrol intake \"…\" --accept \"…\" 先收一条）"
      }${paths.length ? `\n可用 Path：${paths.map((p) => `${p.id}(${p.allowedPaths.join(",") || "."})`).join("、")}` : ""}`,
      "E_USAGE",
    );
  }
  try {
    const res = reqApprove(db, root, { requirementId, pathId, channel: "cli" });
    const req = getReq(db, requirementId);
    console.log(`${res.requirementId} + ${res.pathId}  已批准，契约已冻结`);
    if (res.contractCommit) console.log(`契约提交：${res.contractCommit.slice(0, 8)}（Agent 改不了它，改了内核会拒）`);
    if (req?.acceptance?.length) {
      console.log(`冻结的验收：`);
      for (const a of req.acceptance) console.log(`  · ${a}`);
    }
    console.log(`\n下一步：devcontrol next —— 内核会告诉你该拆哪条任务`);
    return 0;
  } catch (error) {
    return failCli(error.message, error.code ?? "E_ERROR", error.data ?? null, 1);
  }
}

/**
 * devcontrol ask "问题" [--options a,b] [--task T-00x]
 *
 * 为什么需要它：AGENTS.md 把「遇到歧义用 ask，不要猜」写成硬规则，
 * 而 ask 只在 MCP 里。纯 CLI 用户照规矩办事，却发现无路可走——
 * 要么违反规则自己猜，要么被迫去开控制台（而那是 Owner 的地盘）（T-103）。
 */
export function cmdAsk(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const question = flag("question") ?? args.find((a) => !a.startsWith("--"));
  if (!question) {
    return failCli('用法：devcontrol ask "你的问题" [--options 选项A,选项B] [--task T-00x]', "E_USAGE");
  }
  const actor = flag("actor") ?? process.env.DEVCONTROL_ACTOR ?? "agent";
  // 不给 --task 就用手上正在办的那条：问到哪条任务头上，Agent 本来就知道
  let taskId = flag("task");
  if (!taskId) {
    const held = db.prepare("SELECT id FROM tasks WHERE status='doing' AND claimed_by=? AND closing_token IS NULL").all(actor);
    if (held.length !== 1) {
      return failCli(
        held.length ? `你手上有 ${held.length} 条在办任务，用 --task 指定问哪一条` : `${actor} 手上没有在办任务，用 --task T-00x 指定`,
        "E_NO_TASK",
        { holding: held.map((t) => t.id) },
        1,
      );
    }
    taskId = held[0].id;
  }
  const options = (flag("options") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const res = ask(db, { taskId, question, options });
  if (!res.questionId) {
    console.log("配额已满（同时最多 3 个未答问题），这次只记了事件。等 Owner 回答后在控制台看。");
    return 0;
  }
  console.log(`${res.questionId}  已提问（${taskId} 已暂停，等 Owner 回答后自动回到待领）`);
  if (options.length) console.log(`选项：${options.join(" / ")}`);
  console.log(`回答后继续：devcontrol task claim ${taskId}`);
  return 0;
}

/**
 * devcontrol bug "标题" --repro "第一步" --repro "第二步" [--symptom …] [--expected …]
 *
 * 同 ask：Agent 撞到「不是自己该修的东西」时需要一条上报的路。
 * 之前只有 MCP 有，纯 CLI 的 Agent 只能把 bug 写进 commit message（没人看得见）。
 */
export function cmdBug(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const every = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
  const title = flag("title") ?? args.find((a) => !a.startsWith("--"));
  if (!title) {
    return failCli('用法：devcontrol bug "一句话说清什么坏了" --repro "第一步" --repro "第二步" [--symptom …] [--expected …] [--severity P1]', "E_USAGE");
  }
  const actor = flag("actor") ?? process.env.DEVCONTROL_ACTOR ?? "agent";
  const res = bugReport(
    db,
    {
      title,
      symptom: flag("symptom"),
      expected: flag("expected"),
      repro: every("repro"),
      severity: flag("severity") ?? "P2",
      requirementId: flag("req"),
    },
    actor,
  );
  console.log(`${res.bugId}  已上报：${title}`);
  console.log("Owner 在控制台「收件箱」裁决（转任务 / 不改）；用 devcontrol status 看有没有结论。");
  return 0;
}

export function cmdRelease(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const sub = args[0] ?? "list";
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    if (sub === "list") {
      const rows = listReleases(db);
      if (!rows.length) console.log("还没有发布（devcontrol release create \"v0.1\"）");
      for (const r of rows) console.log(`${r.id}  [${r.status}]  ${r.title}  ${r.tasks.length - r.pending}/${r.tasks.length} done${r.target_date ? `  target ${r.target_date}` : ""}`);
      return 0;
    }
    if (sub === "create") {
      const title = args[1] ?? flag("title");
      if (!title) {
        return failCli('用法：devcontrol release create "v0.1" [--target 2026-01-01]', "E_USAGE");
        return 2;
      }
      console.log(JSON.stringify(createRelease(db, { title, targetDate: flag("target") }), null, 2));
      return 0;
    }
    if (sub === "plan") {
      const id = args[1];
      const tasks = args.slice(2).filter((a) => /^T-/.test(a));
      console.log(JSON.stringify(planRelease(db, { id, tasks }), null, 2));
      return 0;
    }
    if (sub === "ship") {
      console.log(JSON.stringify(shipRelease(db, { id: args[1], root }), null, 2));
      return 0;
    }
    if (sub === "show") {
      console.log(JSON.stringify(getRelease(db, args[1]), null, 2));
      return 0;
    }
    return failCli("未知子命令：list | create | plan | ship | show", "E_USAGE");
  } catch (error) {
    return failCli(error.message, error.code ?? "E_ERROR", error.data ?? null, 1);
  }
}

export function cmdExport() {
  const root = resolveRoot();
  const db = openDb(root);
  process.stdout.write(`${exportMarkdown(db)}\n`);
  return 0;
}

export function cmdEvidence(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const id = args[0];
  if (!id) {
    const rows = db.prepare("SELECT id,task_id,command,exit_code,started_at FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 8").all();
    if (!rows.length) {
      console.log("还没有验收记录（收口时才会产生）");
      return 0;
    }
    for (const r of rows) console.log(`${r.id}  ${r.task_id}  exit=${r.exit_code}  ${r.command}  ${r.started_at}`);
    console.log("\n看某一次的输出：devcontrol evidence run-xxxx");
    return 0;
  }
  const row = db.prepare("SELECT * FROM runs WHERE id=?").get(id);
  if (!row) {
    return failCli(`没有这次运行：${id}（devcontrol evidence 看最近的）`, "NOT_FOUND", { runId: id }, 1);
    return 2;
  }
  console.log(`${row.id}  ${row.task_id}  断言 #${row.assertion_idx}`);
  console.log(`命令：${row.command}`);
  console.log(`退出码：${row.exit_code}   耗时：${row.duration_ms}ms   时间：${row.started_at}`);
  console.log(`提交：${row.head ?? "—"}`);
  console.log("─".repeat(64));
  console.log(row.output || "（没有输出）");
  return 0;
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  try {
    // 没有项目库就别往下走：openDb 会凭空建一个空库，用户看到「0 个任务」
    // 还以为自己初始化过了。init / help / 版本号天然不需要库（T-098）。
    const NEEDS_DB = new Set(["run", "commit", "renew", "next", "task", "intake", "approve", "ask", "bug", "flow", "close", "status", "bootstrap", "stats", "report", "memory", "doctor", "evidence", "doc", "release", "export", "serve", "mcp"]);
    if (NEEDS_DB.has(cmd)) {
      const root = resolveRoot();
      if (!fs.existsSync(dbPath(root))) {
        return failCli(`这里还没有 devcontrol 项目（${root}）`, "E_NOT_INIT");
      }
    }
    switch (cmd) {
      case "init":
        return cmdInit(args);
      case "run":
        return await cmdRun(args);
      case "commit":
        return cmdCommit(args);
      case "renew":
        return cmdRenew(args);
      case "next":
        return cmdNext();
      case "task":
        return cmdTask(args);
      case "intake":
        return cmdIntake(args);
      case "approve":
        return cmdApprove(args);
      case "ask":
        return cmdAsk(args);
      case "bug":
        return cmdBug(args);
      case "flow":
        return cmdFlow(args);
      case "close":
        return await cmdClose(args);
      case "status":
        return await cmdStatus();
      case "stats":
        return cmdStats();
      case "report":
        return cmdReport(args);
      case "memory":
        return await cmdMemory(args);
      case "doctor":
        return cmdDoctor();
      case "evidence":
        return cmdEvidence(args);
      case "doc":
        return cmdDoc(args);
      case "release":
        return cmdRelease(args);
      case "export":
        return cmdExport();
      case "serve":
        return await startConsole(args);
      case "mcp":
        return await runMcp();
      case "--version":
      case "-v":
        console.log(VERSION);
        return 0;
      case "bootstrap":
        return await cmdStatus();
      case "help":
      case "--help":
      case "-h":
      case undefined:
        console.log(`devcontrol ${VERSION} — 极小的研发纪律内核

  devcontrol init [--weak] [--no-mcp]  建 .devcontrol/、Path 草稿、MCP 配置（--no-mcp 则不写）、AGENTS.md
  devcontrol run -- <cmd>            跑一条命令并记为测试证据（有在办任务时生效）
  devcontrol commit -m "<msg>"       只提交 scope 内文件，自动写 Task-Id trailer
                                    接活前就存在的改动会拦住（那是上一任留下的），
                                    确认要一起提交就加 --take-over
  devcontrol renew [T-00x]          续租（TTL 45 分钟；commit 等写操作也会自动续期）
  devcontrol task create --req FR-001 --path P-001 --title "…"   纯 CLI 建任务（--kind/--scope/--accept/--depends 可选）
  devcontrol task claim T-00x       领取任务（纯 CLI，租约 45 分钟）
  devcontrol task list              任务清单
  devcontrol next                   内核认为你现在该做的那一件事（参数可直接照抄）
  devcontrol stats                  纪律三数：被拦 / 返工 / 绕过（内核到底有没有在起作用）
  devcontrol report [--days 7] [--json]  周报：这一周收口几条、拦在哪、净改动多少（默认 markdown）
  devcontrol intake "标题" --accept "npm test :: exit==0"   收需求（草稿）——纯 CLI 模式的第一步
  devcontrol approve FR-001 --path P-001   批准需求并冻结契约（之后 Agent 改不了验收）
  devcontrol ask "问题" [--options a,b] [--task T-00x]   遇到歧义就问，别猜（任务会暂停等 Owner 回答）
  devcontrol bug "标题" --repro "第一步" [--repro …]   上报不属于本任务的 bug（Owner 在控制台裁决）
  devcontrol flow <list|show|save|apply>  流程模板：把做过的交付沉淀下来复用（存 .devcontrol/flows/）
  devcontrol close [T-00x] [--resolved-by "…"]  收口：核验 Agent 留下的测试证据（内核不跑测试）
  devcontrol status                  摘要：next / actions / plan / 记忆命中（bootstrap 是它的别名）
  devcontrol help                    就是这份说明（--help / -h 同义）
  devcontrol evidence [run-xxxx]    看验收证据（退出码与输出；不给编号看最近 8 次）
  devcontrol memory [status|list|search|add|export|reindex|promote|demote|delete]  通用记忆
  devcontrol doctor                  对账：幽灵 done / 未落地 / 悬空 claim / 文档漂移
  devcontrol doc [add|list]          登记文档并检测漂移（改了没登记 → doc 漂移）
  devcontrol release [list|create|plan|ship]  发布：一组任务全 done 才能 ship
  devcontrol export                  markdown 快照
  devcontrol serve [--port 7373] [--host 127.0.0.1] [--project <path>…]  Owner 控制台
                                     --host 0.0.0.0 让局域网里别的机器也能打开（默认只听本机）；
                                     想加一道门就设 DEVCONTROL_OWNER_TOKEN，设了才校验
  devcontrol mcp                     MCP stdio 服务（13 个动作，启动时顺带拉起控制台）
`);
        return 0;
      default:
        return failCli(
          `未知命令：${cmd}。可用命令见 devcontrol --help（或 devcontrol help）`,
          "E_USAGE",
          { command: cmd },
        );
    }
  } catch (error) {
    if (process.env.DEVCONTROL_DEBUG) console.error(error.stack);
    return failCli(error.message, error.code ?? "E_ERROR", error.data ?? null, 1);
  }
}
