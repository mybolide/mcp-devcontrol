// devcontrol — 项目上下文：init 时采一次，之后每次任务直接喂给 Agent
//
// 解决的问题不是「Agent 会不会读文档」，而是**每次任务都要重新探索一遍项目**。
// 一个几百行的小仓库，它读五六个文件就摸清了；一个几千文件的项目，每接一个任务
// 就要重新找「建表写在哪、mapper 怎么命名、业务代码放哪」，这时间是纯浪费。
//
// 所以分两件事：
//   ① init 时探测项目类型，产出一份「该写哪几篇上下文」的清单（模板 + 填写指导）
//   ② Agent 写完之后，claim 时把内容**直接塞进返回**，不是给路径
//
// 为什么是「清单」而不是内核自己生成正文：内核不认识业务，写不出「为什么金额用分」。
// 但内核知道**该问哪些问题**、以及**哪些答案能被代码验证**。
import fs from "node:fs";
import path from "node:path";
import { planSteps } from "./context-templates.js";

/** 上下文文档放这里。放文档目录下，和代码分开，但仍在仓库里（要能进 git） */
export const CONTEXT_DIR = "docs/project-context";
export const CONTEXT_INDEX = "docs/project-context.md";

/** claim 时塞进上下文的上限：超了就只给索引 + 摘要，不给全文 */
export const CONTEXT_MAX_CHARS = 12000;

const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * 探测项目形态。只回答「这大概是个什么项目」，用于**决定该问哪些问题**，
 * 不用于决定门禁——门禁永远只认契约里的命令。
 */
export function detectProjectShape(root) {
  const has = (name) => fs.existsSync(path.join(root, name));
  const pkg = (() => {
    try {
      return JSON.parse(read(path.join(root, "package.json")) ?? "{}");
    } catch {
      return {};
    }
  })();
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasDep = (...names) => names.some((n) => Object.hasOwn(deps, n));

  const lang = [];
  if (pkg.type === "module" || has("package.json")) lang.push("JavaScript/TypeScript");
  if (has("go.mod")) lang.push("Go");
  if (has("Cargo.toml")) lang.push("Rust");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) lang.push("Java/Kotlin");
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) lang.push("Python");
  if (lang.length === 0) lang.push("未识别");

  // 形态：决定「该怎么加功能」这一篇写什么
  let shape = "library";
  if (hasDep("express", "koa", "fastify", "@nestjs/core", "@hapi/hapi") || has("go.mod") && has("main.go")) shape = "backend-api";
  else if (hasDep("react", "vue", "svelte", "@angular/core")) shape = "frontend-spa";
  else if (hasDep("next", "nuxt", "@remix-run/react", "@sveltejs/kit")) shape = "fullstack";
  else if (hasDep("react-native", "expo") || has("pubspec.yaml")) shape = "mobile";
  else if (pkg.bin) shape = "cli";
  else if (has("pom.xml") || has("build.gradle")) shape = "backend-api";

  // 分层迹象：有这些目录就说「按层放」，没有就说「看现有文件放」
  const topDirs = (() => {
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => !n.startsWith(".") && !["node_modules", "dist", "build", "target", "coverage", "vendor"].includes(n));
    } catch {
      return [];
    }
  })();

  return {
    languages: lang,
    shape,
    topDirs,
    packageManager: has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : has("package.json") ? "npm" : null,
    deps: Object.keys(deps).sort(),
    entry: typeof pkg.main === "string" ? pkg.main : null,
  };
}

/** 该写哪几篇。每篇都对应一个「Agent 每次都会重新问一次」的问题 */
export function contextDocsFor(shape) {
  const common = [
    { file: "architecture.md", ask: "目录怎么分工？模块之间的依赖方向是什么？什么代码放哪一层？" },
    { file: "data-model.md", ask: "表/集合建在哪？字段命名什么风格？金额、时间、状态这类值怎么存？读写走哪个入口？" },
  ];
  const byShape = {
    "backend-api": [
      { file: "how-to-add-endpoint.md", ask: "加一个新接口要改哪几个文件？按什么顺序改？" },
      { file: "error-handling.md", ask: "业务错误怎么表达？错误码在哪定义？怎么映射成 HTTP 状态码？" },
    ],
    "frontend-spa": [
      { file: "how-to-add-page.md", ask: "加一个新页面要改哪几个文件？路由、状态、请求分别放哪？" },
      { file: "state-and-data.md", ask: "状态放哪？请求怎么发？失败怎么展示？" },
    ],
    fullstack: [
      { file: "how-to-add-endpoint.md", ask: "加一个接口要改哪几个文件？前后端怎么约定？" },
      { file: "how-to-add-page.md", ask: "加一个页面要改哪几个文件？" },
    ],
    mobile: [
      { file: "how-to-add-page.md", ask: "加一个页面要改哪几个文件？导航怎么注册？" },
      { file: "platform-notes.md", ask: "哪些平台差异必须显式处理？" },
    ],
    cli: [
      { file: "how-to-add-command.md", ask: "加一个子命令要改哪几个文件？参数怎么解析、怎么报错？" },
    ],
    library: [
      { file: "how-to-add-function.md", ask: "加一个新功能要改哪几个文件？导出约定是什么？" },
    ],
  };
  return [...common, ...(byShape[shape] ?? byShape.library), { file: "how-to-test.md", ask: "测试放哪？怎么命名？断言什么？" }];
}

/**
 * 生成「填写任务」：内核给模板和问题，正文由 Agent 从真实代码里提取。
 *
 * 为什么不让内核直接写正文：内核不认识业务，写出来就是空话（我们之前那 5 条
 * 「不留 TODO」式的规范就是这么来的）。但内核能问对问题——而问题对了，
 * Agent 从代码里找答案这件事它是会做的。
 */
export function buildContextPlan(root, shape = detectProjectShape(root)) {
  // 每篇都带上 shape，模板按形态挑（backend-api 才有「怎么加接口」那篇）
  const docs = contextDocsFor(shape.shape).map((d) => ({ ...d, shape: shape.shape }));
  return {
    ...shape,
    docsDir: CONTEXT_DIR,
    indexPath: CONTEXT_INDEX,
    docs,
    // 模板 + 问题一起给：模板约束结构（形状一致才扫得动、才看得出哪段过期），
    // 问题约束内容（答不上来就说明这篇没有真东西）。
    steps: planSteps(docs, CONTEXT_DIR, CONTEXT_INDEX),
    rules: [
      "每条都要能从代码里指出来源：写 `文件路径:行号`，指不出来就别写",
      "贴代码就贴真实的，不许用 ... 省略，不许编造",
      "只写「看代码看不出来的」：为什么这么选、哪些地方是历史遗留、哪些是约定俗成",
      "已经写在代码里的东西不用复述——Agent 自己能读",
      "反例必须点名：「xxx 是遗留，别扩展」，否则 Agent 会把它当先例",
      "**模板里填不出真内容的段落，整段删掉**：宁可少一节，不要一节空话",
    ],
  };
}

/**
 * 检查项目上下文有没有过期——判据全部是机械的，不需要理解代码语义。
 *
 * 为什么需要这个：上下文写完之后代码继续变，规范不跟着变就成了「权威的错误来源」，
 * 比没有规范更糟。但「这条规则还对不对」是语义判断，内核做不了；
 * 「出现了规范里没提过的新东西」是事实判断，内核做得来。
 *
 * @param {string} root
 * @param {{addedFiles?: string[], changedFiles?: string[]}} change 本次改动
 */
export function contextDrift(root, change = {}) {
  const loaded = loadContext(root);
  if (!loaded) return { ready: false, reasons: [], needsAttention: false };

  const docs = loaded.text;
  const added = change.addedFiles ?? [];
  const changed = change.changedFiles ?? [];
  const reasons = [];

  // ① 出现了规范里从没提过的目录 → architecture 那篇该补
  //
  // 判据只看「目录路径在上下文里出现过没有」，不猜语义。
  // 比顶层目录更细一层：`src/` 早就写过，但 `src/billing/` 是新的，这才是该补的东西。
  const dirsOf = (files) =>
    files
      .map((f) => String(f).split("/").slice(0, -1).join("/")) // 去掉文件名
      .filter((d) => d && d !== "." && !d.startsWith(".") && !d.startsWith(CONTEXT_DIR));
  const newDirs = [...new Set([...dirsOf(added), ...dirsOf(changed)])].filter((d) => !docs.includes(d));
  if (newDirs.length) {
    reasons.push({
      id: "new-dir",
      detail: `出现规范里没提过的目录：${newDirs.slice(0, 3).join("、")}`,
      fix: "architecture.md 该补一句这个目录是干什么的，或说明它不该存在",
    });
  }

  // ② 改了依赖清单，但规范里的依赖策略没动 → 依赖策略该更新
  const depFile = [...added, ...changed].find((f) => /(^|\/)(package\.json|go\.mod|Cargo\.toml|pom\.xml|build\.gradle)$/.test(f));
  if (depFile && !(changed.includes(CONTEXT_INDEX) || changed.some((f) => f.startsWith(CONTEXT_DIR + "/")))) {
    reasons.push({
      id: "deps",
      detail: `依赖清单变了（${depFile}），但项目上下文没跟着改`,
      fix: "如果新依赖改变了「可以用什么库」的约定，data-model.md 或索引的「依赖策略」要更新",

    });
  }

  // ③ 上下文文档自己引用的文件已经不存在了 → 那条规则大概率失效
  //    只在「本次确实有改动」时检查：没改动时引用丢失是历史问题，不该赖这一笔。
  if (added.length || changed.length) {
    const refs = [...docs.matchAll(/`([\w./-]+\.[a-zA-Z]+):\d+`/g)].map((m) => m[1]);
    const dangling = [...new Set(refs)].filter((rel) => !fs.existsSync(path.join(root, rel)));
    if (dangling.length) {
      reasons.push({
        id: "dangling-ref",
        detail: `上下文引用的文件已不存在：${dangling.slice(0, 3).join("、")}`,
        fix: "这几条规则要么删掉，要么更新到新位置——引用了不存在的文件，等于给了个假证据",
      });
    }
  }

  return { ready: true, reasons, needsAttention: reasons.length > 0 };
}

/** 读一份上下文文档（不读索引，索引单独处理） */
function readDoc(root, rel) {
  const abs = path.join(root, rel);
  const body = read(abs);
  if (body === null) return null;
  return body.trim();
}

/**
 * 把项目上下文组装成「能直接塞进 claim 返回」的一段文字。
 *
 * 优先给全文；总长超过 CONTEXT_MAX_CHARS 时降级成「索引 + 每篇首行摘要」，
 * 并明确告诉 Agent「要细节就自己读这个文件」——**给路径是兜底，不是主路径**。
 */
export function loadContext(root, { maxChars = CONTEXT_MAX_CHARS } = {}) {
  const index = readDoc(root, CONTEXT_INDEX);
  if (index === null) return null;

  const dir = path.join(root, CONTEXT_DIR);
  const files = (() => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch {
      return [];
    }
  })();

  const parts = [`## 项目上下文（${CONTEXT_INDEX}）\n\n${index}`];
  let total = index.length;
  const skipped = [];

  for (const f of files) {
    const rel = `${CONTEXT_DIR}/${f}`;
    const body = readDoc(root, rel);
    if (body === null) continue;
    if (total + body.length > maxChars) {
      // 超了：只给标题行，让人知道有这篇、去哪里找
      const firstLine = body.split("\n").find((l) => l.trim()) ?? f;
      skipped.push(`${rel} — ${firstLine.replace(/^#+\s*/, "").slice(0, 60)}`);
      continue;
    }
    parts.push(`### ${rel}\n\n${body}`);
    total += body.length;
  }

  if (skipped.length) {
    parts.push(
      `### 其余上下文（未随任务下发，需要时自己读）\n\n${skipped.join("\n")}\n\n总长超过 ${maxChars} 字符，只下发了索引和部分正文。改到上面没列出的模块时，先读对应文件再动手。`,
    );
  }

  return { text: parts.join("\n\n"), chars: total, docs: files.length, truncated: skipped.length > 0 };
}

/** 上下文是否已就绪——init 后、Agent 写之前是 false */
export function contextStatus(root) {
  const hasIndex = readDoc(root, CONTEXT_INDEX) !== null;
  const dir = path.join(root, CONTEXT_DIR);
  const files = (() => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
  })();
  return { ready: hasIndex, indexPath: CONTEXT_INDEX, docs: files.length, dir: CONTEXT_DIR };
}

/**
 * 把填写计划渲染成一份可读的文件——**每个 agent 都读这一份，不是读 stdout**。
 *
 * 为什么要有这个文件而不是只打 stdout：模板全文有好几百行，灌进终端没人看。
 * 写成文件之后 Agent 可以按需读、可以分段读，人也能在编辑器里翻。
 */
export function renderContextPlan(plan) {
  const head = [
    "# 项目上下文填写计划",
    "",
    "> 这份文件由 `devcontrol init` 生成。做完之后删掉即可（它不会被 claim 下发）。",
    "",
    `项目形态：${plan.shape}　语言：${plan.languages.join(" / ")}`,
    `顶层目录：${plan.topDirs.join(" / ") || "（无）"}`,
    "",
    "## 怎么用",
    "",
    "按下面每一节的模板写对应文件。**方括号是占位符，要换成从代码里看出来的真实内容。**",
    "填不出真内容的段落整段删掉——宁可少一节，不要一节空话。",
    "",
    "## 硬要求",
    "",
    ...plan.rules.map((r, i) => `${i + 1}. ${r}`),
    "",
  ];
  const body = plan.steps.map((s) => {
    const parts = [`## ${s.action}`, ""];
    if (s.ask) parts.push(`**要回答**：${s.ask}`, "");
    if (s.skeleton) parts.push("**骨架**（照着填，不要改结构）：", "", "````markdown", s.skeleton, "````", "");
    else parts.push("（这一篇没有固定骨架，按上面的问题自组织。）", "");
    return parts.join("\n");
  });
  return [...head, ...body].join("\n");
}

/**
 * 把填写计划写到 .devcontrol/context-plan.md。
 * CLI 和 MCP 自动初始化都要做这件事，所以放在这里一处。
 */
export function writeContextPlan(root, plan) {
  const abs = path.join(root, ".devcontrol", "context-plan.md");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, renderContextPlan(plan), "utf8");
  return abs;
}
