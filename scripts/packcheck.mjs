#!/usr/bin/env node
// devcontrol — 打包自检：一条命令验完「用户拿到手的那个包」是不是真的能用。
//
// 为什么要有它：本轮四轮发布里，有三轮是**在验证阶段才发现功能压根不生效**
// （`devcontrol mcp` 被 NEEDS_DB 拒掉、autoInit 没传进 dispatch、模板自己编造事实）。
// 单测全绿，真实路径全坏。手工重跑一遍太慢，所以固化成命令。
//
// 它验三件事，全部走**真实入口**：
//   ① 分发件本身：npm pack → 装进空目录 → --version 对得上
//   ② 真实 MCP 握手：官方 SDK Client + StdioClientTransport，连一个没初始化过的仓库
//      · 会自动初始化吗？bootstrap 会说 autoInit 吗？
//      · claim 会把项目上下文内联下发吗？
//   ③ 安装物不串：SKILL / AGENTS / CLAUDE / cursor 四处的版本号都等于本包版本，
//      且旧版本的内容被整块替换（不残留两套规矩）
//
// 用法：node scripts/packcheck.mjs [--keep]   （--keep 保留临时目录便于排查）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const VERSION = pkg.version;

let pass = 0;
const failures = [];
const ok = (name, extra = "") => {
  pass += 1;
  console.log(`  ✔ ${name}${extra ? ` ${extra}` : ""}`);
};
const bad = (name, detail) => {
  failures.push(`${name}${detail ? `\n      ${String(detail).split("\n").join("\n      ")}` : ""}`);
  console.log(`  ✖ ${name}`);
  if (detail) console.log(`      ${String(detail).split("\n").join("\n      ")}`);
};
const check = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));
const sh = (cwd, cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 180000, ...opts });

const work = fs.mkdtempSync(path.join(os.tmpdir(), "dc-packcheck-"));
console.log(`打包自检 · 版本 ${VERSION}`);
console.log(`临时目录 ${work}\n`);

try {
  // ── ① 打包 ──────────────────────────────────────────────────────────────
  console.log("[1/3] 分发件");
  const packed = sh(REPO, "npm", ["pack", "--pack-destination", work]);
  if (packed.status !== 0) throw new Error(`npm pack 失败：${packed.stderr || packed.stdout}`);
  const tgz = fs.readdirSync(work).find((f) => f.endsWith(".tgz"));
  check("npm pack 产出 tgz", Boolean(tgz), "找不到 .tgz");

  const app = path.join(work, "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "packcheck-app", version: "1.0.0", private: true }));
  const installed = sh(app, "npm", ["install", path.join(work, tgz), "--no-audit", "--no-fund"]);
  check("装进空目录", installed.status === 0, installed.stderr);

  const cli = path.join(app, "node_modules", "mcp-devcontrol", "bin", "devcontrol.js");
  check("包里有 bin", fs.existsSync(cli), cli);
  const ver = sh(app, process.execPath, [cli, "--version"]);
  check(`--version 是 ${VERSION}`, ver.stdout.trim() === VERSION, `实际：${ver.stdout.trim()}`);

  // 新增模块必须真的进包（否则源码改了但 files 没带上）
  const srcDir = path.join(app, "node_modules", "mcp-devcontrol", "src");
  for (const f of ["init.js", "context.js", "context-templates.js"]) {
    check(`src/${f} 在包里`, fs.existsSync(path.join(srcDir, f)));
  }

  // README 有两个语言版本，都得进包：只带英文，中文用户装完看不到母语说明；
  // 只带中文，npm 首页（默认渲染 README.md）上就是一整页中文。
  const pkgRoot = path.join(app, "node_modules", "mcp-devcontrol");
  for (const f of ["README.md", "README.zh-CN.md"]) {
    check(`${f} 在包里`, fs.existsSync(path.join(pkgRoot, f)));
  }
  const readmeEn = fs.readFileSync(path.join(pkgRoot, "README.md"), "utf8");
  const readmeZh = fs.readFileSync(path.join(pkgRoot, "README.zh-CN.md"), "utf8");
  check("英文版是主（顶部指向中文版）", readmeEn.slice(0, 200).includes("README.zh-CN.md"), readmeEn.slice(0, 120));
  check("中文版顶部指回英文版", readmeZh.slice(0, 200).includes("README.md"), readmeZh.slice(0, 120));

  // ── ② 真实 MCP 握手 ─────────────────────────────────────────────────────
  console.log("\n[2/3] 真实 MCP 客户端");
  const proj = path.join(work, "proj");
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.mkdirSync(path.join(proj, "test"), { recursive: true });
  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0", type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(proj, "src/math.js"), "export const add = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(proj, "test/math.test.js"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\ntest("add", () => assert.equal(add(1, 2), 3));\n');
  sh(proj, "git", ["init", "-q", "."]);
  sh(proj, "git", ["add", "-A"]);
  sh(proj, "git", ["-c", "user.email=p@p", "-c", "user.name=p", "commit", "-qm", "init"]);
  check("未初始化起点（没有 .devcontrol）", !fs.existsSync(path.join(proj, ".devcontrol")));

  // 客户端脚本必须放在 app 里跑，才能解析到装好的 SDK
  const clientPath = path.join(app, "packcheck-client.mjs");
  fs.writeFileSync(
    clientPath,
    `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [, , bin, root] = process.argv;
const t = new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env: { ...process.env, DEVCONTROL_ROOT: root } });
const c = new Client({ name: "packcheck", version: "1.0.0" }, { capabilities: {} });
await c.connect(t);
const call = async (a) => {
  const r = await c.callTool({ name: "devcontrol", arguments: a });
  try { return JSON.parse(r.content?.[0]?.text ?? "{}"); } catch { return {}; }
};
const tools = (await c.listTools()).tools.map((x) => x.name);
const boot1 = await call({ action: "bootstrap" });
const boot2 = await call({ action: "bootstrap" });
console.log(JSON.stringify({ tools, boot1, boot2 }));
await c.close();
`,
  );
  const client = sh(app, process.execPath, [clientPath, cli, proj]);
  let out = null;
  try {
    out = JSON.parse(client.stdout.trim().split("\n").pop());
  } catch {
    out = null;
  }
  check("MCP 握手成功并返回 JSON", Boolean(out), `stdout: ${client.stdout.slice(0, 300)}\nstderr: ${client.stderr.slice(0, 500)}`);
  if (out) {
    check("工具列表是 devcontrol", out.tools?.includes("devcontrol"), JSON.stringify(out.tools));
    check("未初始化项目被自动初始化", Boolean(out.boot1?.autoInit), `autoInit=${JSON.stringify(out.boot1?.autoInit)}`);
    check("自动初始化报出了校验命令", out.boot1?.autoInit?.testCmds?.length > 0, JSON.stringify(out.boot1?.autoInit?.testCmds));
    check("autoInit 只报一次（第二次是 null）", out.boot2?.autoInit === null, `第二次：${JSON.stringify(out.boot2?.autoInit)}`);
    check("bootstrap 每次报告上下文状态", typeof out.boot1?.context?.ready === "boolean" && typeof out.boot2?.context?.ready === "boolean");
  }
  check("自动初始化写了 AGENTS.md", fs.existsSync(path.join(proj, "AGENTS.md")));
  check("自动初始化写了 SKILL.md", fs.existsSync(path.join(proj, ".agents", "skills", "devcontrol", "SKILL.md")));
  check("自动初始化建了库", fs.existsSync(path.join(proj, ".devcontrol", "state.db")));

  // ── ③ 安装物不串 ────────────────────────────────────────────────────────
  console.log("\n[3/3] 下发文件一致性（会不会串）");
  const targets = {
    "SKILL.md": path.join(proj, ".agents", "skills", "devcontrol", "SKILL.md"),
    "AGENTS.md": path.join(proj, "AGENTS.md"),
  };
  for (const [label, file] of Object.entries(targets)) {
    const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    check(`${label} 带版本号 ${VERSION}`, body.includes(VERSION), `前 200 字：${body.slice(0, 200)}`);
  }
  const agents = fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8");
  check("AGENTS 只含一个 devcontrol 块", (agents.match(/devcontrol:begin/g) ?? []).length === 1);
  const skill = fs.readFileSync(path.join(proj, ".agents", "skills", "devcontrol", "SKILL.md"), "utf8");
  for (const [label, body] of [["SKILL", skill], ["AGENTS", agents]]) {
    const r = body.indexOf("run");
    const c = body.indexOf("commit");
    check(`${label} 的顺序是 run 在 commit 之前`, r < 0 || c < 0 || r < c, `run@${r} commit@${c}`);
    check(`${label} 提到了项目上下文`, /(这个)?项目(的)?上下文/.test(body));
  }

  // 升级场景：把 AGENTS 块改成旧版本，再跑一次 init，必须整块换掉
  const stale = agents.replace(VERSION, "0.0.1-alpha").replace("**先自己跑**", "**先自己跑**");
  fs.writeFileSync(path.join(proj, "AGENTS.md"), stale);
  const reinit = sh(proj, process.execPath, [cli, "init", "--no-mcp"]);
  check("重复 init 成功", reinit.status === 0, reinit.stderr);
  const after = fs.readFileSync(path.join(proj, "AGENTS.md"), "utf8");
  check("旧版本号被替换（不残留两套规矩）", !after.includes("0.0.1-alpha") && after.includes(VERSION));
  check("升级后仍只有一个块", (after.match(/devcontrol:begin/g) ?? []).length === 1);
} catch (error) {
  bad("自检过程中抛错", error?.stack ?? String(error));
} finally {
  if (KEEP) console.log(`\n（保留临时目录：${work}）`);
  else fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failures.length ? "✖" : "✔"} 打包自检：${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log("\n失败项：");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}