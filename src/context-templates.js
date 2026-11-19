// devcontrol — 项目上下文的骨架模板
//
// **模板的价值不是提示，是约束结构。**
// 只给问题（「目录怎么分工？」），Agent 会按自己的习惯写：有的篇写成散文，有的写成表，
// 以后没法扫、没法 diff、也看不出「这一段三个月没更新过」。
// 给骨架之后，每篇的形状是固定的，人和机器都能快速定位。
//
// 方括号里是占位符，告诉 Agent 该填什么。写不出真实内容的段落**允许整段删掉**——
// 宁可少一节，不要一节空话。这条要写进 init 的输出里，否则模板会被填成谜语。

const ARCH = `# 架构

## 分层与依赖方向

| 层 | 目录 | 放什么 | 不许做什么 |
|---|---|---|---|
| [层名] | \`[路径]\` | [职责] | [禁止] |

依赖方向：[例如 controller → service → mapper，单向；谁都不许反向 import]

## 一个功能要改哪几个文件

[按顺序列出——这是 Agent 每次都要重新摸一遍的东西]

1. \`[文件]\` — [改什么]
2. \`[文件]\` — [改什么]

## 历史遗留（别当先例）

- \`[文件路径:行号]\` — [什么问题]，正确做法是 [怎么做]，**不要扩展它**`;

const DATA = `# 数据模型

## 表 / 集合建在哪

- 定义位置：\`[文件:行号]\`
- 建表方式：[一个 SCHEMA 字符串常量 / 迁移文件 / ORM 模型]
- 迁移：[有/无]。[无就明写「改 SCHEMA 不会迁移已有库」]

## 字段约定

| 约定 | 做法 | 依据 |
|---|---|---|
| 命名 | [snake_case / camelCase] | \`[文件:行号]\` |
| 金额 | [整数「分」/ 其他] | \`[文件:行号]\` |
| 时间 | [ISO 字符串 / 时间戳] | \`[文件:行号]\` |
| 状态枚举 | [CHECK 约束 / 代码常量] | \`[文件:行号]\` |

## 读写入口

- 读：\`[函数 / 文件]\`
- 写：\`[函数 / 文件]\`
- [有没有唯一入口？绕过它算不算违规？]`;

const TEST = `# 测试

## 跑测试

\`\`\`sh
[实际命令]
\`\`\`

## 测试放哪、怎么命名

- 位置：\`[目录]\`
- 命名：\`[规范，例如与被测模块同名 .test.js]\`

## 断言风格

[例如：从 controller 入口打进去，断 status 和 body；错误分支断错误码而不是断文案]

## 覆盖约定

[项目实际的约定；没有就写「暂无强制要求」]

## 反例

- [如果有违反上述约定的既有测试，点名]`;

const ERR = `# 错误处理

## 业务错误怎么表达

- 错误类型：\`[类名]\`，定义在 \`[文件:行号]\`
- 错误码：[在哪定义，有哪些]

## 怎么映射成响应

| 错误码 | HTTP 状态 | 在哪映射 |
|---|---|---|
| \`[E_XXX]\` | [404] | \`[文件:行号]\` |

## 不许做什么

- [例如：不许抛裸 Error；不许用 null 表示失败；不许在 controller 里判业务规则]`;

const ADD_ENDPOINT = `# 怎么加一个接口（按顺序）

1. \`[mapper 文件]\` — 加 SQL 函数
2. \`[service 文件]\` — 加业务规则和校验
3. \`[controller 文件]\` — 加 handler，把结果包成响应
4. \`[错误映射处:行号]\` — 新错误码要加映射（不加会静默变 500）
5. \`[测试文件]\` — 加用例
6. 跑测试

现成例子：\`[文件:行号]\` 是标准写法。

**不要**：在 controller 里写 SQL / 在 service 里拼 HTTP 状态码 / 新开一个平行的模块。`;

const ADD_FUNCTION = `# 怎么加一个功能

1. \`[文件]\` — [改什么]
2. \`[测试]\` — 加用例
3. 跑测试

现成例子：\`[文件:行号]\`。

导出约定：[例如具名 export，不用 default]`;

const ADD_PAGE = `# 怎么加一个页面

1. \`[路由注册处]\` — 注册路由
2. \`[页面文件]\` — 写页面
3. \`[状态 / 数据]\` — 接数据
4. \`[测试]\`

现成例子：\`[文件:行号]\``;

const ADD_COMMAND = `# 怎么加一个子命令

1. \`[命令注册处:行号]\` — 注册
2. \`[实现文件]\` — 写实现
3. \`[测试]\`

参数解析：[用什么解析，怎么报错]`;

const STATE_DATA = `# 状态与数据

- 状态放哪：\`[文件 / 机制]\`
- 请求怎么发：\`[封装位置]\`
- 失败怎么展示：\`[约定]\``;

const PLATFORM = `# 平台差异

| 平台 | 必须显式处理的事 |
|---|---|
| [iOS] | [例如权限声明] |
| [Android] | [例如后台限制] |`;

/** 索引页：这是 Agent 每次先读的一页，所以把「什么时候看哪篇」写死在这里 */
export const INDEX_SKELETON = `# 项目上下文索引

> 每次接任务时内核会把这里和下面各篇的正文直接下发给你。所以：**只写看代码看不出来的**。

## 这个项目是什么

[一句话：做什么用、谁在用、和别的系统什么关系]

## 文档导航

| 文档 | 一句话 | 什么时候看 |
|---|---|---|
| [architecture.md](project-context/architecture.md) | [一句话] | [什么时候] |
| [data-model.md](project-context/data-model.md) | [一句话] | [什么时候] |

## 全局背景（子文档不重复）

- 运行时 / 语言：[例如 Node 22+，ESM]
- 验收命令：\`[实际命令]\`
- 第三方依赖策略：[例如零依赖 / 只用某几个]`;

/** 通用骨架：任何项目形态都有这几篇 */
const COMMON = {
  "architecture.md": ARCH,
  "data-model.md": DATA,
  "how-to-test.md": TEST,
  "error-handling.md": ERR,
};

/** 按项目形态多出来的那几篇 */
const BY_SHAPE = {
  "backend-api": { "how-to-add-endpoint.md": ADD_ENDPOINT },
  "frontend-spa": { "how-to-add-page.md": ADD_PAGE, "state-and-data.md": STATE_DATA },
  fullstack: { "how-to-add-endpoint.md": ADD_ENDPOINT, "how-to-add-page.md": ADD_PAGE },
  mobile: { "how-to-add-page.md": ADD_PAGE, "platform-notes.md": PLATFORM },
  cli: { "how-to-add-command.md": ADD_COMMAND },
  library: { "how-to-add-function.md": ADD_FUNCTION },
};

/**
 * 取某篇的骨架。认不出来返回 null（调用方据此决定只给问题、不给模板）。
 * shape 缺省按 library 兜底——它是「没有框架特征的项目」的通用形态。
 */
export function skeletonFor(file, shape = "library") {
  if (COMMON[file]) return COMMON[file];
  const table = BY_SHAPE[shape] ?? BY_SHAPE.library;
  return table[file] ?? null;
}

/** init 要打印的「该写哪几篇」——问题 + 骨架成对给出 */
export function planSteps(contextDocs, contextDir, contextIndex) {
  return [
    {
      file: contextIndex,
      action: `创建 ${contextIndex}（索引）`,
      ask: "每篇一句话 + 什么时候看它——这是 Agent 每次先读的那一页",
      skeleton: INDEX_SKELETON,
    },
    ...contextDocs.map((d) => ({
      file: `${contextDir}/${d.file}`,
      action: `创建 ${contextDir}/${d.file}`,
      ask: d.ask,
      skeleton: skeletonFor(d.file, d.shape),
    })),
  ];
}