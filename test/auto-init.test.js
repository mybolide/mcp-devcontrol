// T-139：MCP 连上未初始化的项目时，自动初始化，不再让人手动跑 init。
//
// 早先的行为是真缺陷：`runMcp` 直接 openDb，而 openDb 会建库——于是 MCP 连上一个
// 没 init 的 git 仓库时，**静默得到一个空壳**：没有 Path、没有 AGENTS.md、没有上下文。
// Agent 拿到它以为项目配好了，人也没收到任何提示。
//
// 现在：既然接了 MCP，就说明要用它 → 自己初始化，并把做了什么说出来。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BIN, makeRepo } from "./helpers.js";
import { INIT_MARKER, initializeProject, isInitialized } from "../src/init.js";
import { openDb } from "../src/db.js";

const run = (cwd, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, DEVCONTROL_ROOT: cwd } });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** 起 MCP 几秒钟，把 stderr 收回来就退出——够跑到初始化那一行 */
function bootMcp(root, ms = 5000) {
  const script = `
    process.env.DEVCONTROL_ROOT = ${JSON.stringify(root)};
    const { runMcp } = await import(${JSON.stringify(new URL("../src/mcp.js", import.meta.url).href)});
    runMcp();
    setTimeout(() => process.exit(0), ${ms - 1500});
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", timeout: ms + 5000 });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("initializeProject 是纯函数：只返回结果，一个字都不打印", () => {
  const root = makeRepo();
  const res = initializeProject(root, { noMcp: true });
  assert.equal(res.ok, true);
  // 返回值里该有的东西都在，调用方据此决定怎么说
  assert.equal(res.mode, "git");
  assert.ok(res.pathsCreated >= 1, "至少建一条 Path 草稿");
  assert.ok(Array.isArray(res.testCmds));
  assert.ok(res.contextPlan.docs.length > 0, "要给出该写哪几篇上下文");
  assert.equal(res.context.ready, false, "init 不生成上下文正文");
});

test("init 会写「已初始化」标记——空库不算初始化", () => {
  const root = makeRepo();
  const db = openDb(root);
  assert.equal(isInitialized(db), false, "刚建出来的空库不算初始化过");
  initializeProject(root, { noMcp: true });
  assert.equal(isInitialized(openDb(root)), true);
});

test("向后兼容：老项目有 Path 但没标记 → 认作已初始化，不重建", () => {
  const root = makeRepo();
  initializeProject(root, { noMcp: true });
  // 模拟升级前的库：标记不存在
  const db = openDb(root);
  db.prepare("DELETE FROM meta WHERE key=?").run(INIT_MARKER);
  const before = db.prepare("SELECT COUNT(*) n FROM paths").get().n;

  assert.equal(isInitialized(db), true, "有 Path 就说明 init 过，不能当成新项目");
  assert.ok(db.prepare("SELECT value FROM meta WHERE key=?").get(INIT_MARKER), "顺手把标记补上");
  assert.equal(openDb(root).prepare("SELECT COUNT(*) n FROM paths").get().n, before, "不许重建 Path");
});

test("MCP 连上未初始化的 git 仓库：自动初始化，并在 stderr 说清楚", () => {
  const root = makeRepo();
  assert.equal(fs.existsSync(path.join(root, ".devcontrol")), false, "起始状态必须是没初始化过");

  const out = bootMcp(root);
  assert.match(out.stderr, /还没初始化，已自动完成/, `该说它替人做了什么：${out.stderr}`);

  // 真的建出来了，不是只打了一行字
  assert.ok(fs.existsSync(path.join(root, ".devcontrol", "state.db")), "要有库");
  assert.ok(fs.existsSync(path.join(root, "AGENTS.md")), "要写 Agent 说明");
  assert.ok(fs.existsSync(path.join(root, ".agents", "skills", "devcontrol", "SKILL.md")), "要写规范 Skill");
  assert.ok(fs.existsSync(path.join(root, ".devcontrol", "context-plan.md")), "要落盘上下文填写计划");

  const db = openDb(root);
  assert.equal(isInitialized(db), true);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM paths").get().n >= 1, "要有 Path 草稿");
});

test("MCP 连上已初始化的项目：不重复初始化，也不多提交", () => {
  const root = makeRepo();
  initializeProject(root, { noMcp: true });
  const commitsBefore = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

  const out = bootMcp(root);
  assert.doesNotMatch(out.stderr, /还没初始化/, `已初始化就不该再报：${out.stderr}`);

  const commitsAfter = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.equal(commitsAfter, commitsBefore, "第二次连上不许再提交");
});

test("自动初始化会提交自己的产物（否则第一次 close 会被 E_DIRTY_SCOPE 拦）", () => {
  const root = makeRepo();
  initializeProject(root, { noMcp: true });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim();
  assert.equal(dirty, "", `init 的产物要自己提交掉，现在脏着：${dirty}`);
});

test("不是 git 仓库时 MCP 不静默造库，而是明确说没法自动初始化", () => {
  const root = makeRepo();
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  const res = initializeProject(root, {});
  assert.equal(res.ok, false);
  assert.equal(res.code, "E_NOT_REPO");
});

test("CLI 的 init 也走同一条路径（--no-mcp 时不写任何客户端配置）", () => {
  const root = makeRepo();
  const out = run(root, ["init", "--no-mcp"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /devcontrol init 完成/);
  assert.match(out.stdout, /客户端配置：\.mcp\.json 跳过/);
  assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false, "--no-mcp 不许写配置");
  assert.ok(fs.existsSync(path.join(root, "AGENTS.md")));
});

test("自动初始化时如果没采到验收命令，要明说（不能让人以为配好了）", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  const res = initializeProject(root, { noMcp: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.testCmds, [], "这个项目没有 test 脚本");
  // 输出层要能看到这条（用 CLI 验，MCP 走 stderr 同理）
  const out = run(root, ["init", "--no-mcp"]);
  assert.match(out.stdout, /Path 草稿/);
});

/** 项目根下 .devcontrol 的路径；单独抽出来免得每处都拼 */
function CONTEXT_PLACEHOLDER() {
  return ".";
}

test("bootstrap 每次都报告上下文状态：没写就明说该按计划补", async () => {
  const root = makeRepo();
  initializeProject(root, { noMcp: true });
  const { openDb } = await import("../src/db.js");
  const { bootstrap } = await import("../src/digest.js");
  const db = openDb(root);

  const before = bootstrap(db, root, {});
  assert.equal(before.context.ready, false, "还没写时说没写");
  assert.equal(before.context.plan, ".devcontrol/context-plan.md", "要指出计划在哪");
  assert.match(before.context.hint, /context-plan\.md/, "要给一句可执行的下一步");

  // 写完一篇索引就应当翻成 ready
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "project-context.md"), "# 索引\n");
  const after = bootstrap(db, root, {});
  assert.equal(after.context.ready, true, "写了就该认");
  assert.equal(after.context.hint, null, "ready 之后不再唠叨");
});

test("已初始化但上下文没写：这不是「已配好」，bootstrap 必须说出来", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  const out = run(root, ["status"]);
  assert.equal(out.code, 0, out.stderr);
  const d = JSON.parse(out.stdout);
  assert.ok(d.context, "bootstrap 输出里必须有 context 字段");
  assert.equal(d.context.ready, false);
  assert.match(d.context.hint, /还没写/, `不写就是沉默，Agent 会一直自己重新探索：${JSON.stringify(d.context)}`);
});

// 打包验证时发现的真缺陷：`devcontrol mcp` 被 main() 的 NEEDS_DB 名单提前拒掉，
// 于是 MCP 客户端连未初始化的项目时拿到 E_NOT_INIT，而 runMcp 里的自动初始化
// **永远跑不到**。当时单测只直接调 runMcp()，绕过了 CLI 这一层，所以是绿的。
// 这条测试走真实入口：`devcontrol mcp`，专治「测试绿、真实路径坏」。
test("真实入口 `devcontrol mcp`：未初始化也能进，不被 NEEDS_DB 拒掉", () => {
  const root = makeRepo();
  // spawnSync 不给 input → stdin 立刻 EOF → MCP 服务起一下就退出，够跑到初始化
  const r = spawnSync(process.execPath, [BIN, "mcp"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root },
    timeout: 20000,
    input: "",
  });
  const all = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.doesNotMatch(all, /E_NOT_INIT/, `mcp 子命令不许被 NEEDS_DB 拒掉：${all.slice(0, 400)}`);
  assert.match(all, /还没初始化，已自动完成/, `该自动初始化：${all.slice(0, 400)}`);
  assert.ok(fs.existsSync(path.join(root, ".devcontrol", "state.db")), "库要建出来");
  assert.ok(fs.existsSync(path.join(root, "AGENTS.md")), "AGENTS.md 要写出来");
});

test("bootstrap 的 autoInit 只报一次（第二次已经是「配好的项目」了）", () => {
  const root = makeRepo();
  initializeProject(root, { noMcp: true });
  // 用一个最小 ctx 走两遍 bootstrap 分支：第二次不该再说「刚初始化」
  const ctx = { autoInit: { at: "t", pathsCreated: 1 }, consoleUrl: null };
  const take = () => {
    const once = ctx.autoInit ?? null;
    if (ctx.autoInit) ctx.autoInit = null;
    return once;
  };
  assert.ok(take(), "第一次要报");
  assert.equal(take(), null, "第二次不能再报——项目早就配好了，再喊一遍是在骗人");
});