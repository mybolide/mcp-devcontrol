// devcontrol — CLI 入口：init / run / commit / status / doctor / export / serve / mcp
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { metaGet, metaSet, openDb, dataDir, dbPath } from "./db.js";
import { taskClose, taskRenew, taskCreate, taskClaim } from "./gates.js";
import { git, head, isRepo, toplevel, statusPorcelain, commitFiles, lsFiles } from "./git.js";
import { inScope, sha256 } from "./fingerprint.js";
import { bootstrap } from "./digest.js";
import { doctor, exportMarkdown } from "./report.js";
import { createRelease, getRelease, listReleases, planRelease, shipRelease } from "./release.js";
import { getTask, mapTask, listTasks, listReqs, listPaths, listDocs, reqIntake } from "./store.js";
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

const AGENTS_BLOCK = `<!-- devcontrol:begin -->
开工先跑 \`devcontrol status\`：它返回的 next 就是下一件事，不要自己挑。
改代码前必须 task.claim；不许修改 acceptance，不许自选命令；只改 scope 内的文件。
改完 \`devcontrol commit -m "..."\`（只提交 scope 内文件），再 \`devcontrol close\`（内核在干净检出里重跑验收）。
遇到歧义用 ask，不要猜。
控制台地址在 \`devcontrol status\` 的 console 字段；MCP 连接时会自动拉起，挂掉会自动重建。
<!-- devcontrol:end -->`;

// 纯 CLI 模式（不注册 MCP）时，纪律块改成 CLI 说法
const AGENTS_BLOCK_CLI = AGENTS_BLOCK.replace(
  "控制台地址在 `devcontrol status` 的 console 字段；MCP 连接时会自动拉起，挂掉会自动重建。",
  "控制台：需要时自己起 `devcontrol serve`（本模式不注册 MCP，不会自动拉起）。",
);

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
    console.error(Object.assign(new Error("E_NOT_REPO: 这里不是 git 仓库。加 --weak 使用弱模式（只跑验收，没有提交归属与 scope 校验）"), { code: "E_NOT_REPO" }).message);
    return 1;
  }
  process.chdir(root);
  fs.mkdirSync(path.join(dataDir(root), "runs"), { recursive: true });
  fs.mkdirSync(path.join(dataDir(root), "contracts"), { recursive: true });
  const unignored = dropBlanketDataDirIgnore();
  appendLines(".gitignore", [
    ".devcontrol/state.db*",
    ".devcontrol/runs/",
    ".devcontrol/r2-wt/",
    ".devcontrol/r2-wt-legacy/",
    ".devcontrol/console.lock",
  ]);
  appendLines(".gitattributes", ["* text=auto eol=lf"]);
  const noMcp = args.includes("--no-mcp");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? new Set(String(args[onlyIdx + 1] ?? "").split(",").filter(Boolean)) : null;

  const db = openDb(root);
  metaSet(db, "mode", gitMode ? "git" : "weak");
  const pkgFile = path.join(root, "package.json");
  let testCmds = [];
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      if (pkg.scripts?.test) testCmds = [pkg.scripts.test.includes("--") ? `npm test` : "npm test"];
    } catch {
      /* ignore */
    }
  }
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
    const n = Number(db.prepare("SELECT value FROM meta WHERE key='counter:P'").get()?.value ?? 0) + 1;
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
  const agentsFile = path.join(root, "AGENTS.md");
  const agents = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, "utf8") : "";
  if (!agents.includes("<!-- devcontrol:begin -->")) {
    fs.writeFileSync(agentsFile, `${agents}${agents ? "\n" : ""}${noMcp ? AGENTS_BLOCK_CLI : AGENTS_BLOCK}\n`, "utf8");
  }
  // init 自己写的配置要自己提交：否则第一次 close 会被 E_DIRTY_SCOPE 拦住
  const managed = [".gitignore", ".gitattributes", "AGENTS.md", ...(noMcp ? [] : [".mcp.json", ".cursor/mcp.json", "opencode.json"])].filter((f) =>
    fs.existsSync(path.join(root, f)),
  );
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
- AGENTS.md 标记块已就绪
- 控制台：随 MCP 连接自动启动并复用（Owner 也可以手动 devcontrol serve）
- 托管文件：${initCommit ? `已提交 chore(devcontrol): init @ ${initCommit.slice(0, 8)}` : "无变化"}
${noMcp ? "- 纯 CLI 模式：没有注册 MCP，Agent 直接用 devcontrol status / commit / close；需要控制台时自己 devcontrol serve" : `- Codex 需要手动加：\n${CODEX_SNIPPET}`}`);
  return 0;
}

export async function cmdRun(args) {
  const idx = args.indexOf("--");
  const command = idx >= 0 ? args.slice(idx + 1).join(" ") : args.join(" ");
  if (!command) {
    console.error("用法：devcontrol run -- <command>");
    return 2;
  }
  const root = resolveRoot();
  const result = await execCommand(root, command);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log(`\n[devcontrol] exit ${result.exit} · ${result.durationMs}ms`);
  return result.exit;
}

export function cmdCommit(args) {
  const root = resolveRoot();
  const msgIdx = args.indexOf("-m");
  const message = msgIdx >= 0 ? args[msgIdx + 1] : null;
  if (!message) {
    console.error('用法：devcontrol commit -m "<message>" [--actor name]');
    return 2;
  }
  const actorIdx = args.indexOf("--actor");
  const actor = actorIdx >= 0 ? args[actorIdx + 1] : process.env.DEVCONTROL_ACTOR || "agent";
  const db = openDb(root);
  if (metaGet(db, "mode") === "weak") {
    console.error("E_WEAK_NO_GIT: 弱模式没有 git，不能提交；直接把改动留在工作树里，然后 devcontrol close");
    return 1;
  }
  const doing = db.prepare("SELECT * FROM tasks WHERE status='doing' AND claimed_by=? AND closing_token IS NULL").all(actor);
  if (!doing.length) {
    console.error(`E_NO_TASK: ${actor} 手上没有在办任务，先 task.claim`);
    return 1;
  }
  if (doing.length > 1) {
    console.error(`E_WIP_LIMIT: ${actor} 有多个在办任务：${doing.map((t) => t.id).join(", ")}`);
    return 1;
  }
  const task = getTask(db, doing[0].id);
  taskRenew(db, root, { id: task.id }, actor); // 写操作续租（契约 §5.1）
  const dirty = statusPorcelain(root, ["--untracked-files=all"])
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => {
      const rest = l.slice(3).trim();
      const arrow = rest.lastIndexOf(" -> ");
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, "");
    })
    .filter(Boolean);
  const mine = dirty.filter((f) => inScope(f, task.scope));
  const foreign = dirty.filter((f) => !inScope(f, task.scope) && !f.startsWith(".devcontrol/"));
  if (foreign.length) {
    console.error(`E_SCOPE_VIOLATION: 以下改动不在 ${task.id} 的 scope 内：\n${foreign.join("\n")}`);
    return 1;
  }
  if (!mine.length) {
    console.error("没有可提交的改动（scope 内为空）");
    return 1;
  }
  const body = `${message}\n\nTask-Id: ${task.id}\nDevControl-Base: ${task.base_head}`;
  const sha = commitFiles(root, mine, body, { author: actor });
  console.log(`${sha.slice(0, 8)}  ${task.id}  ${mine.length} 个文件`);
  return 0;
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
      console.error('用法：devcontrol task create --req FR-001 --path P-001 --title "一言说清" [--kind fix] [--scope src,test] [--accept "npm test :: exit==0"]');
      return 2;
    }
    const accepts = every("accept");
    const deriveFrom = Number(flag("derive") ?? 0);
    const acceptance = (accepts.length ? accepts : ["npm test :: exit==0"]).map((assertion) => ({ deriveFrom, assertion }));
    const scope = flag("scope") ? flag("scope").split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const task = taskCreate(db, root, { requirementId: req, pathId, kind: flag("kind") ?? "feature", title, scope, acceptance });
    console.log(`${task.id}  已建  ${task.title}`);
    console.log(`scope: ${(task.scope ?? []).join(", ")}`);
    return 0;
  }
  if (sub === "claim") {
    const id = args.slice(1).find((a) => /^T-\d+$/.test(a));
    if (!id) {
      console.error("用法：devcontrol task claim T-00x [--actor name]");
      return 2;
    }
    const claimed = taskClaim(db, root, { id }, actor);
    console.log(`${claimed.id} 已领取（租约到 ${claimed.claimExpiresAt}）`);
    console.log(`scope: ${claimed.scope.join(", ")}`);
    for (const cmd of claimed.testCmds) console.log(`验收命令: ${cmd}`);
    return 0;
  }
  if (sub === "list") {
    for (const t of db.prepare("SELECT id,status,kind,title FROM tasks ORDER BY id").all()) console.log(`${t.id}  ${t.status.padEnd(8)}${t.kind.padEnd(8)}${t.title}`);
    return 0;
  }
  console.error("用法：devcontrol task <create|claim|list> ...");
  return 2;
}

export function cmdNext() {
  const root = resolveRoot();
  const db = openDb(root);
  const digest = bootstrap(db, root);
  if (!digest.next) return 0;
  console.log(`${digest.next.action}  ${digest.next.why ?? ""}`);
  console.log(JSON.stringify(digest.next.args ?? {}, null, 2));
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
    console.error(`E_NO_TASK: ${actor} 手上没有在办任务`);
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
      console.error(doing.length ? `E_WIP_LIMIT: ${actor} 有多个在办任务，请指明任务号` : `E_NO_TASK: ${actor} 手上没有在办任务`);
      return 1;
    }
    id = doing[0].id;
  }
  try {
    const res = await taskClose(db, root, { id, resolvedBy });
    console.log(JSON.stringify(res, null, 2));
    return 0;
  } catch (error) {
    const payload = { ok: false, code: error.code ?? "E_INTERNAL", message: error.message, data: error.data ?? null };
    console.error(JSON.stringify(payload, null, 2));
    return 1;
  }
}

export async function cmdStatus() {
  const root = resolveRoot();
  const db = openDb(root);
  const doing = db.prepare("SELECT * FROM tasks WHERE status='doing' ORDER BY id LIMIT 1").get();
  const memory = await recallMemories(root, doing ? mapTask(doing) : null);
  console.log(JSON.stringify(bootstrap(db, root, { memories: memory.memories }), null, 2));
  return 0;
}

export async function cmdMemory(args) {
  const sub = args[0] ?? "status";
  const cfg = memoryConfig();
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
      console.error('用法：devcontrol memory search "<关键词>"');
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
      console.error('用法：devcontrol memory add "标题" --body "现象/原因/解法" [--kind pitfall|howto|decision|preference|snippet|note] [--tags a,b]');
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
      console.error(`用法：devcontrol memory ${sub} M-xxxxxxxx`);
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
      console.error("用法：devcontrol memory delete M-xxxxxxxx");
      return 2;
    }
    console.log(softDeleteMemory(cfg, args[1]) ? "已软删除" : "没有这条记录");
    return 0;
  }
  console.error("未知子命令：status | list | search | add | export | reindex | promote | demote | delete");
  return 2;
}

export function cmdDoctor() {
  const root = resolveRoot();
  const db = openDb(root);
  const items = doctor(db, root);
  if (!items.length) console.log("doctor: 一切正常");
  for (const it of items) console.log(`${it.severity === "error" ? "ERROR" : "warn "} ${it.code} ${it.taskId ?? ""} ${it.detail}`);
  return items.some((i) => i.severity === "error") ? 1 : 0;
}

export function cmdDoc(args) {
  const root = resolveRoot();
  const db = openDb(root);
  const sub = args[0] ?? "list";
  if (sub === "add") {
    const rel = args[1];
    if (!rel) {
      console.error("用法：devcontrol doc add <相对路径> [--title 标题] [--kind spec|adr|guide]");
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
  console.error("未知子命令：add | list");
  return 2;
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
        console.error('用法：devcontrol release create "v0.1" [--target 2026-01-01]');
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
      console.log(JSON.stringify(shipRelease(db, { id: args[1] }), null, 2));
      return 0;
    }
    if (sub === "show") {
      console.log(JSON.stringify(getRelease(db, args[1]), null, 2));
      return 0;
    }
    console.error("未知子命令：list | create | plan | ship | show");
    return 2;
  } catch (error) {
    console.error(`${error.code ?? "E_ERROR"}: ${error.message}`);
    if (error.data) console.error(JSON.stringify(error.data, null, 2));
    return 1;
  }
}

export function cmdExport() {
  const root = resolveRoot();
  const db = openDb(root);
  process.stdout.write(`${exportMarkdown(db)}\n`);
  return 0;
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  try {
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
      case "close":
        return await cmdClose(args);
      case "status":
        return await cmdStatus();
      case "memory":
        return await cmdMemory(args);
      case "doctor":
        return cmdDoctor();
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
      case "--help":
      case "-h":
      case undefined:
        console.log(`devcontrol ${VERSION} — 极小的研发纪律内核

  devcontrol init [--weak] [--no-mcp]  建 .devcontrol/、Path 草稿、MCP 配置（--no-mcp 则不写）、AGENTS.md
  devcontrol run -- <cmd>            采证执行（记录退出码与耗时）
  devcontrol commit -m "<msg>"       只提交 scope 内文件，自动写 Task-Id trailer
  devcontrol renew [T-00x]          续租（TTL 45 分钟；commit 等写操作也会自动续期）
  devcontrol task create --req FR-001 --path P-001 --title "…"   纯 CLI 建任务（--kind/--scope/--accept 可选）
  devcontrol task claim T-00x       领取任务（纯 CLI，租约 45 分钟）
  devcontrol task list              任务清单
  devcontrol next                   内核认为你现在该做的那一件事（参数可直接照抄）
  devcontrol close [T-00x] [--resolved-by "…"]  收口：干净检出内重跑验收（R0–R5）
  devcontrol status                  bootstrap 摘要：next / actions / plan / 记忆命中
  devcontrol memory [status|list|search|add|export|reindex|promote|demote|delete]  通用记忆
  devcontrol doctor                  对账：幽灵 done / 未落地 / 悬空 claim / 文档漂移
  devcontrol doc [add|list]          登记文档并检测漂移（改了没登记 → doc 漂移）
  devcontrol release [list|create|plan|ship]  发布：一组任务全 done 才能 ship
  devcontrol export                  markdown 快照
  devcontrol serve [--port 7373] [--project <path>…]  Owner 控制台（MCP 连上会自动启动/复用）
  devcontrol mcp                     MCP stdio 服务（13 个动作，启动时顺带拉起控制台）
`);
        return 0;
      default:
        console.error(`未知命令：${cmd}`);
        return 2;
    }
  } catch (error) {
    console.error(`${error.code ?? "E_ERROR"}: ${error.message}`);
    if (process.env.DEVCONTROL_DEBUG) console.error(error.stack);
    return 1;
  }
}