// devcontrol — 初始化：CLI 的 `devcontrol init` 和 MCP 连上时的自动初始化，共用同一套逻辑。
//
// 为什么要抽出来：MCP 的 stdout 是 JSON-RPC 通道，往里打一行人话就废了。
// 早先 `cmdInit` 直接 console.log，所以 MCP 连上未初始化的项目时只能**静默建一个空库**——
// 没有 Path、没有 AGENTS.md、没有上下文，Agent 拿到的是个空壳，而人以为自己配好了。
//
// 现在分成两半：
//   · initializeProject()  只干活、返回结构化结果，一个字都不打印
//   · cmdInit()            调它，再把结果打成人话
// 这样 MCP 那条路也能调，不需要管输出通道。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { metaSet, openDb } from "./db.js";
import { commitFiles, isRepo, lsFiles } from "./git.js";
import { isVendorPath, vendorIgnores } from "./vendor.js";
import { detectTestCmds } from "./testcmd.js";
import { buildContextPlan, contextStatus } from "./context.js";
import { installAgentFiles, SKILL_REL } from "./skill.js";

const DEVCONTROL_BIN = fileURLToPath(new URL("../bin/devcontrol.js", import.meta.url));

/** 顶层目录里不该被当成 Path 候选的 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".devcontrol", "coverage", ".next", "target", "vendor"]);

export const CODEX_SNIPPET = `# ~/.codex/config.toml
[mcp_servers.devcontrol]
command = "${process.execPath}"
args = ["${DEVCONTROL_BIN}", "mcp"]
env = { DEVCONTROL_ROOT = "<项目绝对路径>" }`;

/** 「这个项目初始化过没有」的唯一判据。空库不算——MCP 静默建出来的也是空库。 */
export const INIT_MARKER = "initialized";



const mcpServerConfig = (root) => ({
  mcpServers: {
    devcontrol: { command: process.execPath, args: [DEVCONTROL_BIN, "mcp"], env: { DEVCONTROL_ROOT: root } },
  },
});

function appendLines(root, file, lines) {
  const abs = path.join(root, file);
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
function dropBlanketDataDirIgnore(root, file = ".gitignore") {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) return false;
  const cur = fs.readFileSync(abs, "utf8");
  const lines = cur.split("\n");
  const kept = lines.filter((l) => !BLANKET_DATA_DIR.test(l.trim()));
  if (kept.length === lines.length) return false;
  fs.writeFileSync(abs, kept.join("\n"), "utf8");
  return true;
}

/**
 * 「这个项目初始化过没有」的唯一判据。空库不算——MCP 静默建出来的就是空库。
 *
 * 向后兼容：这个标记是新加的，老项目没有。但老项目**已经有 Path 或任务**，
 * 那些只可能是 init 之后产生的——所以把它们也认作「已初始化」，
 * 顺手把标记补上（补一次，之后就走标记）。不这么做的话，升级后第一次连 MCP
 * 会把一个用了几个月的项目当成新项目重新初始化一遍。
 */
export function isInitialized(db) {
  const marked = db.prepare("SELECT value FROM meta WHERE key=?").get(INIT_MARKER);
  if (marked) return true;
  const hasWork = db.prepare("SELECT 1 AS x FROM paths LIMIT 1").get() ?? db.prepare("SELECT 1 AS x FROM tasks LIMIT 1").get();
  if (!hasWork) return false;
  metaSet(db, INIT_MARKER, new Date().toISOString());
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

function writeIfMissing(root, rel, value) {
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return true;
}

/** 已有配置但 DEVCONTROL_ROOT 指向别处（仓库被移动/复制）→ 重写，保留其他 MCP server */
function writeMcpConfig(root, rel, value) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return writeIfMissing(root, rel, value) ? "written" : "exists";
  let current;
  try {
    current = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return "invalid"; // 不碰用户手写的坏文件
  }
  const isOpenCode = Boolean(current.mcp);
  const entry = isOpenCode ? current.mcp?.devcontrol : current.mcpServers?.devcontrol;
  if (JSON.stringify(entry) === JSON.stringify(isOpenCode ? value.mcp.devcontrol : value.mcpServers.devcontrol)) return "exists";
  if (isOpenCode) {
    current.mcp = { ...(current.mcp ?? {}), devcontrol: value.mcp.devcontrol };
  } else {
    current.mcpServers = { ...(current.mcpServers ?? {}), devcontrol: value.mcpServers.devcontrol };
  }
  fs.writeFileSync(abs, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  return "updated";
}

/**
 * 真正干活的初始化。**一个字都不打印**，返回结构化结果由调用方决定怎么说。
 *
 * @param {string} root 项目根（git 顶层或 cwd）
 * @param {{noMcp?: boolean, only?: Set<string>|null, weak?: boolean}} opts
 */
export function initializeProject(root, opts = {}) {
  const noMcp = Boolean(opts.noMcp);
  const only = opts.only ?? null;
  const gitMode = isRepo(root);
  if (!gitMode && !opts.weak) {
    // 环境不满足，不是用法错：交给调用方决定怎么报（退出码 1）
    return { ok: false, code: "E_NOT_REPO", root, gitMode };
  }

  fs.mkdirSync(path.join(root, ".devcontrol", "runs"), { recursive: true });
  fs.mkdirSync(path.join(root, ".devcontrol", "contracts"), { recursive: true });
  const unignored = dropBlanketDataDirIgnore(root);
  // 依赖/构建产物默认忽略——但项目特意提交过的（dist/ 进了 git）不能忽略，
  // 否则 git 拒绝再 add，反而把正常提交挡住。
  appendLines(root, ".gitignore", [
    ...notAlreadyTracked(root, vendorIgnores(root)),
    ".devcontrol/state.db*",
    ".devcontrol/memory.db*",
    ".devcontrol/settings.json",
    ".devcontrol/runs/",
    ".devcontrol/console.lock",
    ".devcontrol/console.json",
  ]);
  appendLines(root, ".gitattributes", ["* text=auto eol=lf"]);

  const db = openDb(root);
  metaSet(db, "mode", gitMode ? "git" : "weak");
  // 命令从「项目现在的样子」采一次；之后项目变了，Owner 在控制台点「重采验收命令」
  const detected = detectTestCmds(root);
  const testCmds = detected.cmds;
  let created = 0;
  // 默认只生成一条覆盖全项目的根 Path（"."）：改实现 + 补测试是同一个正常动作，
  // 按顶层目录切会把它拆成两个任务、还得串依赖，人反而要多批一次。
  const dirs = only
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".") && only.has(e.name))
        .map((e) => e.name)
    : ["."];
  for (const dir of dirs) {
    const exists = db.prepare("SELECT 1 FROM paths WHERE allowed_paths_json=?").get(JSON.stringify([dir]));
    if (exists) continue;
    // 计数器可能因早期手工插库或旧 bug 落后，撞号就往下找空号，别用裸 SQLite 错误崩掉
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

  const wroteMcp = noMcp ? "skipped" : writeMcpConfig(root, ".mcp.json", mcpServerConfig(root));
  const wroteCursor = noMcp ? "skipped" : writeMcpConfig(root, ".cursor/mcp.json", mcpServerConfig(root));
  const wroteOpencode = noMcp
    ? "skipped"
    : writeMcpConfig(root, "opencode.json", {
        mcp: { devcontrol: { type: "local", command: [process.execPath, DEVCONTROL_BIN, "mcp"], environment: { DEVCONTROL_ROOT: root } } },
      });
  // Agent 侧安装物：规范 Skill 只有一份，其余都是指针（避免多份内容各自漂移）
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

  // 标记「初始化过」：空库不算（MCP 静默建出来的就是空库）。
  // 放在最后写：中途抛错时不留「看起来配好了」的假象。
  metaSet(db, INIT_MARKER, new Date().toISOString());

  return {
    ok: true,
    root,
    gitMode,
    mode: gitMode ? "git" : "weak",
    unignored,
    pathsCreated: created,
    testCmds,
    detected,
    wroteMcp,
    wroteCursor,
    wroteOpencode,
    agentFiles,
    initCommit,
    contextPlan: buildContextPlan(root),
    context: contextStatus(root),
  };
}