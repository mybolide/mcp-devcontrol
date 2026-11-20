// devcontrol — 能力对照表：同一个能力在三个入口（MCP / CLI / 控制台）各叫什么
//
// 为什么需要这份表：2026-11 的三次演练里，"能力做出来了但没接到某个入口上"连撞三次：
//   · dependsOn 在 MCP 有，CLI 没有 --depends
//   · 多命令验收数据层支持，控制台表单只收一条
//   · 需求验收能写多条命令，批准时只冻结 Path 采到的那条
// 这不是三次独立疏忽，是"五个面同步靠人力"。所以把入口对应关系写成数据，
// 由 test/capabilities.test.js 逐条核对——少接一个入口就红。
//
// 加新能力时：先在这里登记三个入口，再实现；测试会告诉你哪个入口忘了接。

export const CAPABILITIES = [
  {
    name: "创建 Path 草案",
    // Agent 可以准备范围提案，但不能批准它或因此获得文件写权限。
    action: "path.create",
    mcp: ["requirementId", "allowedPaths", "allowNewFiles", "budgetLines", "testCmds"],
    cli: { sub: "path create", flags: ["req", "allow", "allow-new-files", "budget", "test"] },
    console: null,
  },
  {
    name: "建任务",
    action: "task.create",
    // MCP 参数名（zod schema 的字段）
    mcp: ["requirementId", "pathId", "title", "kind", "scope", "acceptance", "dependsOn"],
    // CLI 参数名（--flag 后面那段）
    cli: { sub: "task create", flags: ["req", "path", "title", "kind", "scope", "accept", "depends"] },
    // 控制台没有等价物：Owner 不建任务（那是 Agent 的活）
    console: null,
  },
  {
    name: "领任务",
    action: "task.claim",
    mcp: ["id", "actor"],
    cli: { sub: "task claim", flags: [] },
    console: null,
  },
  {
    name: "交测试证据",
    action: "evidence.record",
    mcp: ["id", "command", "exit", "output"],
    // CLI 的做法是 devcontrol run -- <cmd>：自己跑完顺手记账
    cli: { sub: "run", flags: [] },
    console: null,
  },
  {
    name: "Owner 直接建任务",
    // Agent 侧没有对应动作：它是「下单」，不是「干活」。校验仍然走 taskCreate。
    action: null,
    mcp: null,
    cli: null,
    console: "task.add",
  },
  {
    name: "调任务顺序（置顶）",
    // Backlog 的顺序就是优先级。不搞 priority 标签体系——顺序本身够了。
    action: null,
    mcp: null,
    cli: null,
    console: "task.rank",
  },
  {
    name: "收口",
    action: "task.close",
    mcp: ["id", "resolvedBy"],
    cli: { sub: "close", flags: ["resolved-by"] },
    console: "reopen", // 控制台的等价动作不是收口，是打回重做
  },
  {
    name: "重采验收命令",
    // Agent 侧没有这个动作：这是 Owner 的权力，不进 MCP（见 SKILL「Owner 的动作不在 MCP 里」）
    action: null,
    mcp: null,
    cli: null,
    console: "path.retest",
  },
  {
    name: "调预算",
    action: null,
    mcp: null,
    cli: null,
    console: "path.adjust",
  },
  {
    name: "放行",
    action: null,
    mcp: null,
    cli: null,
    console: "override",
  },
  {
    name: "提问（遇到歧义别猜）",
    action: "ask",
    mcp: ["taskId", "question", "options"],
    cli: { sub: "ask", flags: ["question", "options", "task"] },
    console: "answer",
  },
  {
    name: "上报 bug",
    action: "bug.report",
    mcp: ["title", "symptom", "expected", "repro", "severity", "requirementId"],
    cli: { sub: "bug", flags: ["title", "symptom", "expected", "repro", "severity", "req"] },
    console: "decide",
  },
  {
    name: "记经验",
    action: "memory.write",
    mcp: ["title", "body", "kind", "tags", "project"],
    cli: { sub: "memory add", flags: ["body", "kind", "tags"] },
    console: "memory.promote",
  },
  {
    name: "查经验",
    action: "memory.search",
    mcp: ["query", "limit"],
    cli: { sub: "memory search", flags: [] },
    console: null,
  },

  // ── 以下是「只有 Owner 能做」的动作 ────────────────────────────────────────
  // 它们刻意不进 MCP：Agent 能自己批准需求，纪律就没有意义了。
  // 但必须登记在这里，否则「新按钮悄悄长出来」没人管。
  // 收件和批准有 CLI 入口：--no-mcp 是写进 README 的正式模式，那条路上没有控制台，
  // 不给入口等于「这个模式第 1 步就走不通」（T-104）。它们仍然不进 MCP——
  // Agent 能自己批准自己，纪律就没有意义了。CLI 是人在终端敲的。
  {
    name: "收需求 / 收 Bug",
    action: null,
    mcp: null,
    cli: { sub: "intake", flags: ["title", "accept", "goal"] },
    console: "intake",
  },
  { name: "批准需求 + 冻契约", action: null, mcp: null, cli: { sub: "approve", flags: ["req", "path"] }, console: "approve" },
  { name: "改需求验收", action: null, mcp: null, cli: null, console: "amend" },
  { name: "调任务的 scope / 预算", action: null, mcp: null, cli: null, console: "adjust" },
  { name: "Bug 裁决", action: null, mcp: null, cli: null, console: "decide" },
  { name: "回答 Agent 的提问", action: null, mcp: null, cli: null, console: "answer" },
  { name: "换人接手任务（释放 + 交接卡）", action: null, mcp: null, cli: null, console: "handoff" },
  { name: "释放任务（退回待办，不给卡片）", action: null, mcp: null, cli: null, console: "release" },
  // 放弃是 Owner 的决定：Agent 不能自己宣布「这活不做了」
  { name: "作废需求（连带任务归档）", action: null, mcp: null, cli: null, console: "abandon" },
  { name: "改经验内容并转正", action: null, mcp: null, cli: null, console: "memory.edit" },
  { name: "丢弃经验", action: null, mcp: null, cli: null, console: "memory.drop" },
  { name: "发布（打回滚 tag）", action: null, mcp: null, cli: null, console: "release.ship" },
  { name: "保存设置", action: null, mcp: null, cli: null, console: "settings.save" },
];

/** 开发期自检：表本身别写错（比如登记了 action 却忘了 mcp 参数） */
export function validateTable() {
  const problems = [];
  for (const c of CAPABILITIES) {
    if (c.mcp && !c.action) problems.push(`${c.name}: 有 mcp 参数却没有 action`);
    if (c.action && !Array.isArray(c.mcp)) problems.push(`${c.name}: 有 action 却没登记 mcp 参数`);
    if (c.cli && !c.cli.sub) problems.push(`${c.name}: cli 缺少 sub`);
    if (c.cli && !Array.isArray(c.cli.flags)) problems.push(`${c.name}: cli 缺少 flags 数组`);
  }
  return problems;
}