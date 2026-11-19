// T-134：项目上下文——init 产出填写清单，claim 内联下发。
//
// 要解决的问题不是「Agent 会不会读文档」，而是**每次任务都要重新探索一遍项目**。
// 小仓库读五六个文件就摸清了；几千文件的项目，每接一个任务都要重新找
// 「建表在哪、mapper 怎么命名、业务代码放哪」，这是纯浪费。
//
// 所以：init 时 Agent 写一次（内核只给问题清单），之后每次 claim 直接把内容塞进返回。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BIN, makeRepo } from "./helpers.js";
import { CONTEXT_DIR, CONTEXT_INDEX, CONTEXT_MAX_CHARS, contextStatus, detectProjectShape, loadContext } from "../src/context.js";

const run = (cwd, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const write = (root, rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

/** 建一条已批准的需求 + 任务，返回 taskId */
function readyTask(root, { scope = ["src"] } = {}) {
  run(root, ["init", "--no-mcp"]);
  const intake = run(root, ["intake", "加功能", "--accept", "npm test :: exit==0"]);
  const fr = intake.stdout.match(/FR-\d+/)[0];
  run(root, ["approve", fr, "--path", "P-001"]);
  const created = run(root, ["task", "create", "--req", fr, "--path", "P-001", "--title", "加功能", "--scope", scope.join(",")]);
  return created.stdout.match(/T-\d+/)[0];
}

test("init 会告诉 Agent 该写哪几篇、每篇要回答什么问题", () => {
  const root = makeRepo();
  const out = run(root, ["init", "--no-mcp"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /项目上下文：\*\*还没有\*\*/, "没写上下文时要明说");
  assert.match(out.stdout, /docs\/project-context\.md/, "要指出索引文件路径");
  assert.match(out.stdout, /要回答：/, "每篇都要给一个具体问题，不能只给文件名");
  // 模板套路：不许编造、必须能指出来源
  assert.match(out.stdout, /指不出来就别写/);
});

test("init 不会自己生成正文（内核不认识业务，硬写就是空话）", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  assert.equal(fs.existsSync(path.join(root, CONTEXT_INDEX)), false, "init 不许替 Agent 写正文");
  assert.equal(fs.existsSync(path.join(root, CONTEXT_DIR)), false);
});

test("init 第二次跑：上下文已存在时如实说「已就绪」，不再让写", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  write(root, CONTEXT_INDEX, "# 上下文\n\n- 架构见 architecture.md\n");
  const out = run(root, ["init", "--no-mcp"]);
  assert.match(out.stdout, /项目上下文：已就绪/, `第二次应当说已就绪：${out.stdout}`);
  assert.doesNotMatch(out.stdout, /\*\*还没有\*\*/);
});

test("claim 把上下文**内容**直接下发，不是只给路径", () => {
  const root = makeRepo();
  const id = readyTask(root);
  write(root, CONTEXT_INDEX, "# 项目索引\n\n一句话：这是索引\n");
  write(root, `${CONTEXT_DIR}/architecture.md`, "# 架构\n\n- 业务全在 src/，一个域一个文件（src/a.js:1）\n");

  const out = run(root, ["task", "claim", id]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /## 项目上下文/, `claim 输出里该有上下文：${out.stdout}`);
  assert.match(out.stdout, /这是索引/, "索引正文要下来");
  assert.match(out.stdout, /一个域一个文件/, "分类文档正文也要下来");
});

test("claim 的返回里有结构化的 context 字段（MCP 靠它）", async () => {
  const root = makeRepo();
  const id = readyTask(root);
  write(root, CONTEXT_INDEX, "# 索引\n\n内容甲\n");
  const { openDb } = await import("../src/db.js");
  const { taskClaim } = await import("../src/gates.js");
  const db = openDb(root);
  const r = taskClaim(db, root, { id }, "agent");
  assert.ok(typeof r.context === "string" && r.context.length > 0, "要有 context 字段");
  assert.match(r.context, /内容甲/);
  assert.equal(r.contextChars > 0, true);
  assert.equal(r.contextHint, null, "没截断就不该有提示");
});

test("项目还没写上下文时，claim 要明说没写，不能静默省略", () => {
  const root = makeRepo();
  const id = readyTask(root);
  const out = run(root, ["task", "claim", id]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /还没有上下文文档/, `必须明说，否则 Agent 以为项目没有约定：${out.stdout}`);
});

test("超长时降级：下发的总长不超过上限，并告诉 Agent 剩下的自己读", () => {
  const root = makeRepo();
  write(root, CONTEXT_INDEX, "# 索引\n\n短\n");
  // 三篇各 6000 字符，总共远超上限
  for (const name of ["a", "b", "c"]) {
    write(root, `${CONTEXT_DIR}/${name}.md`, `# ${name}\n\n${"x".repeat(6000)}\n`);
  }
  const loaded = loadContext(root);
  assert.ok(loaded, "应当能读到");
  assert.equal(loaded.truncated, true, "超上限必须标记截断");
  assert.ok(loaded.chars <= CONTEXT_MAX_CHARS, `下发长度不该超过上限：${loaded.chars}`);
  assert.match(loaded.text, /需要时自己读/, "要明确告诉它剩下的去读文件");
});

test("超长时不能把哪一篇整个吞掉不说（要留标题让人知道有这篇）", () => {
  const root = makeRepo();
  write(root, CONTEXT_INDEX, "# 索引\n");
  write(root, `${CONTEXT_DIR}/huge.md`, `# 巨大的一篇\n\n${"y".repeat(CONTEXT_MAX_CHARS + 100)}\n`);
  write(root, `${CONTEXT_DIR}/small.md`, "# 小的一篇\n\n小内容\n");
  const loaded = loadContext(root);
  assert.equal(loaded.truncated, true);
  // 两篇都要能被知道存在：小的进正文，大的至少留标题
  assert.match(loaded.text, /小内容/, "小篇应当完整下发");
  assert.match(loaded.text, /huge\.md/, "被跳过的那篇至少要留路径，否则等于丢失");
});

test("contextStatus：分得清「没写」和「写了」", () => {
  const root = makeRepo();
  assert.equal(contextStatus(root).ready, false);
  write(root, CONTEXT_INDEX, "# 索引\n");
  write(root, `${CONTEXT_DIR}/x.md`, "# x\n");
  const st = contextStatus(root);
  assert.equal(st.ready, true);
  assert.equal(st.docs, 1);
  assert.equal(st.indexPath, CONTEXT_INDEX);
});

test("detectProjectShape：认得出项目形态，决定该问哪些问题", () => {
  const root = makeRepo();
  const lib = detectProjectShape(root);
  assert.equal(lib.shape, "library", "没有框架依赖的 node 项目算 library");
  assert.ok(lib.languages.includes("JavaScript/TypeScript"));

  // 加一个 express 依赖 → 变成 backend-api
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.dependencies = { express: "^4.0.0" };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  assert.equal(detectProjectShape(root).shape, "backend-api");
});

test("backend-api 项目的清单里有「怎么加接口」「错误怎么处理」", () => {
  const root = makeRepo();
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.dependencies = { express: "^4.0.0" };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  const out = run(root, ["init", "--no-mcp"]);
  assert.match(out.stdout, /how-to-add-endpoint\.md/, `要问「怎么加接口」：${out.stdout}`);
  assert.match(out.stdout, /error-handling\.md/, "要问「错误怎么处理」");
});

test("Go 项目也能识别，且给的是它的加功能路径", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "go.mod"), "module m\n\ngo 1.21\n");
  fs.writeFileSync(path.join(root, "main.go"), "package main\n\nfunc main() {}\n");
  const shape = detectProjectShape(root);
  assert.ok(shape.languages.includes("Go"), "要认出 Go");
});
