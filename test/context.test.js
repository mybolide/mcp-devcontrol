// T-134 / T-136：项目上下文——init 产出填写计划（问题 + 模板骨架），claim 内联下发。
//
// 要解决的问题不是「Agent 会不会读文档」，而是**每次任务都要重新探索一遍项目**。
// 小仓库读五六个文件就摸清了；几千文件的项目，每接一个任务都要重新找
// 「建表在哪、mapper 怎么命名、业务代码放哪」，这是纯浪费。
//
// 所以：init 时 Agent 写一次（内核只给模板和问题），之后每次 claim 直接把内容塞进返回。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BIN, makeRepo } from "./helpers.js";
import {
  CONTEXT_DIR,
  CONTEXT_INDEX,
  CONTEXT_MAX_CHARS,
  contextDrift,
  contextStatus,
  detectProjectShape,
  loadContext,
} from "../src/context.js";

const run = (cwd, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const write = (root, rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

const planOf = (root) => fs.readFileSync(path.join(root, ".devcontrol", "context-plan.md"), "utf8");

/** 建一条已批准的需求 + 任务，返回 taskId */
function readyTask(root, { scope = ["src"] } = {}) {
  run(root, ["init", "--no-mcp"]);
  const intake = run(root, ["intake", "加功能", "--accept", "npm test :: exit==0"]);
  const fr = intake.stdout.match(/FR-\d+/)[0];
  run(root, ["approve", fr, "--path", "P-001"]);
  const created = run(root, ["task", "create", "--req", fr, "--path", "P-001", "--title", "加功能", "--scope", scope.join(",")]);
  return created.stdout.match(/T-\d+/)[0];
}

test("init 明说「还没有上下文」，并指出填写计划在哪", () => {
  const root = makeRepo();
  const out = run(root, ["init", "--no-mcp"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /项目上下文：\*\*还没有\*\*/, "没写上下文时要明说");
  assert.match(out.stdout, /context-plan\.md/, "要指出填写计划在哪");
});

test("填写计划里每篇都带：要回答的问题 + markdown 骨架", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  const plan = planOf(root);

  assert.match(plan, /docs\/project-context\.md/, "计划里要指出索引文件路径");
  assert.match(plan, /\*\*要回答\*\*：/, "每篇都要给一个具体问题，不能只给文件名");
  // 只有问题约束不住结构：有的写成散文、有的写成表，以后没法扫、没法 diff
  assert.match(plan, /\*\*骨架\*\*/, "每篇都要带 markdown 骨架");
  assert.match(plan, /```markdown/, "骨架要是可直接填的 markdown 代码块");
  assert.match(plan, /\[文件:行号\]/, "骨架里要留「引用了哪个文件」的占位符");
});

test("填写计划的硬要求必须包含：能指出源、不许编造、可删空段", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  const plan = planOf(root);
  assert.match(plan, /指不出来就别写/, "必须要求每条能指出来源");
  assert.match(plan, /不许编造/, "必须禁止编造");
  assert.match(plan, /整段删掉/, "必须允许删空段，否则模板会被填成谜语");
});

test("init 不会自己生成正文（内核不认识业务，硬写就是空话）", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  assert.equal(fs.existsSync(path.join(root, CONTEXT_INDEX)), false, "init 不许替 Agent 写正文");
  assert.equal(fs.existsSync(path.join(root, CONTEXT_DIR)), false);
});

test("init 第二次跑：上下文已存在时如实说「已就绪」，不再生成填写计划", () => {
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

  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.dependencies = { express: "^4.0.0" };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  assert.equal(detectProjectShape(root).shape, "backend-api");
});

test("backend-api 项目的计划里有「怎么加接口」「错误怎么处理」", () => {
  const root = makeRepo();
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.dependencies = { express: "^4.0.0" };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  run(root, ["init", "--no-mcp"]);
  const plan = planOf(root);
  assert.match(plan, /how-to-add-endpoint\.md/, `要问「怎么加接口」：${plan.slice(0, 400)}`);
  assert.match(plan, /error-handling\.md/, "要问「错误怎么处理」");
});

test("Go 项目也能识别", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "go.mod"), "module m\n\ngo 1.21\n");
  fs.writeFileSync(path.join(root, "main.go"), "package main\n\nfunc main() {}\n");
  const shape = detectProjectShape(root);
  assert.ok(shape.languages.includes("Go"), "要认出 Go");
});

// ── T-136：上下文是否过期（机械判据，零语义理解）────────────────────────────

test("contextDrift：还没写上下文时说 ready=false，不算过期", () => {
  const root = makeRepo();
  const d = contextDrift(root, { addedFiles: ["src/a.js"] });
  assert.equal(d.ready, false);
  assert.equal(d.needsAttention, false, "没写就不谈过期");
});

test("contextDrift：新增了规范里没提过的目录 → 要提醒补 architecture", () => {
  const root = makeRepo();
  write(root, CONTEXT_INDEX, "# 索引\n");
  write(root, `${CONTEXT_DIR}/architecture.md`, "# 架构\n\n业务在 src/。\n");
  const d = contextDrift(root, { addedFiles: ["src/billing/invoice.js"], changedFiles: [] });
  assert.equal(d.needsAttention, true);
  const r = d.reasons.find((x) => x.id === "new-dir");
  assert.ok(r, `该报 new-dir：${JSON.stringify(d.reasons)}`);
  assert.match(r.detail, /billing/, "要点名是哪个目录");
});

test("contextDrift：目录规范里已经提过，就不该再报", () => {
  const root = makeRepo();
  write(root, CONTEXT_INDEX, "# 索引\n");
  write(root, `${CONTEXT_DIR}/architecture.md`, "# 架构\n\n- src/ 放业务\n- test/ 放测试\n");
  const d = contextDrift(root, { addedFiles: ["src/x.js"], changedFiles: ["test/x.test.js"] });
  assert.equal(d.reasons.some((x) => x.id === "new-dir"), false, `src/ 和 test/ 都提过：${JSON.stringify(d.reasons)}`);
});

test("contextDrift：改了依赖清单但上下文没跟着改 → 要提醒", () => {
  const root = makeRepo();
  write(root, CONTEXT_INDEX, "# 索引\n\n- 依赖策略：零依赖\n");
  write(root, `${CONTEXT_DIR}/data-model.md`, "# 数据模型\n");
  const d = contextDrift(root, { changedFiles: ["package.json"] });
  assert.equal(d.reasons.some((x) => x.id === "deps"), true, `该报 deps：${JSON.stringify(d.reasons)}`);
});

test("contextDrift：依赖和上下文一起改了，就不该报", () => {
  const root = makeRepo();
  write(root, CONTEXT_INDEX, "# 索引\n\n- 依赖策略：新增 qs\n");
  const d = contextDrift(root, { changedFiles: ["package.json", CONTEXT_INDEX] });
  assert.equal(d.reasons.some((x) => x.id === "deps"), false, "一起改过就不算过期");
});

test("contextDrift：上下文引用的文件已经不存在 → 那条规则给了假证据", () => {
  const root = makeRepo();
  write(root, CONTEXT_INDEX, "# 索引\n");
  write(root, `${CONTEXT_DIR}/architecture.md`, "# 架构\n\n- 业务在 `src/gone.js:12`，这是标准写法\n");
  const d = contextDrift(root, { changedFiles: ["src/a.js"] });
  const r = d.reasons.find((x) => x.id === "dangling-ref");
  assert.ok(r, `该报 dangling-ref：${JSON.stringify(d.reasons)}`);
  assert.match(r.detail, /src\/gone\.js/);
});

test("contextDrift：没有改动时不去翻旧账（引用丢失是历史问题，不该赖这一笔）", () => {
  const root = makeRepo();
  write(root, CONTEXT_INDEX, "# 索引\n");
  write(root, `${CONTEXT_DIR}/architecture.md`, "# 架构\n\n- 业务在 `src/gone.js:12`\n");
  const d = contextDrift(root, {});
  assert.equal(d.reasons.some((x) => x.id === "dangling-ref"), false);
});

test("close 时把上下文过期记成 observation（摆事实，不硬拦）", async () => {
  const root = makeRepo();
  const id = readyTask(root, { scope: ["src"] });
  write(root, CONTEXT_INDEX, "# 索引\n");
  write(root, `${CONTEXT_DIR}/architecture.md`, "# 架构\n\n业务在 src/。\n");

  // 造一个规范里没提过的新目录
  fs.mkdirSync(path.join(root, "src/billing"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/billing/invoice.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");

  const { openDb } = await import("../src/db.js");
  const { taskClaim, recordEvidence, taskClose } = await import("../src/gates.js");
  const { closeProven } = await import("./helpers.js");
  const db = openDb(root);
  // a.js 已存在，用改它来保证有交付；billing/ 是新增目录
  taskClaim(db, root, { id }, "agent");

  const { commitFiles } = await import("../src/git.js");
  commitFiles(root, ["src/a.js", "src/billing/invoice.js"], `feat: 加 billing\n\nTask-Id: ${id}`, { author: "agent" });

  const res = await closeProven(db, root, { id }, { exit: 0 });
  const ctxObs = (res.observations ?? []).filter((o) => o.id === "context");
  assert.ok(ctxObs.length > 0, `close 该把上下文过期摆出来：${JSON.stringify(res.observations)}`);
  assert.equal(ctxObs.some((o) => o.code === "new-dir"), true, "要点名是哪个目录没写进规范");
});