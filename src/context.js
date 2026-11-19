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
  const docs = contextDocsFor(shape.shape);
  return {
    ...shape,
    docsDir: CONTEXT_DIR,
    indexPath: CONTEXT_INDEX,
    docs,
    steps: [
      { action: `创建 ${CONTEXT_INDEX}（索引：每篇一句话 + 什么时候看它）` },
      ...docs.map((d) => ({ action: `创建 ${CONTEXT_DIR}/${d.file}`, ask: d.ask })),
    ],
    rules: [
      "每条都要能从代码里指出来源：写 `文件路径:行号`，指不出来就别写",
      "贴代码就贴真实的，不许用 ... 省略，不许编造",
      "只写「看代码看不出来的」：为什么这么选、哪些地方是历史遗留、哪些是约定俗成",
      "已经写在代码里的东西不用复述——Agent 自己能读",
      "反例必须点名：「xxx 是遗留，别扩展」，否则 Agent 会把它当先例",
    ],
  };
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
