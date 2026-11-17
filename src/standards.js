// devcontrol — 规范清单：内核收口时会核验的「代码该怎么写」
//
// 为什么要有它：Jira 只有验收（Acceptance，功能对不对），代码写得怎么样靠人 review。
// 我们的场景是 AI 写代码、没人 review，所以这一层必须由内核兜——这是「比 Jira 强一点」的地方。
//
// 但规范不能是隐式的。之前它们散在 gates.js 里：Owner 批准 Path 时看不见、Agent 开工时不知道，
// 被拦了才第一次听说有这条。现在把它写进契约：
//   · Owner 批准时看见自己要守什么
//   · Agent claim 时拿到同一份清单
//   · 被拦时错误码能对上其中一条
//
// 判断标准很干脆：**看 diff 就能知道的归内核，要执行才知道的归 Agent**。
// 所以这里只有静态可判的条目；「测试过没过」不在这——那要 Agent 跑出来交证据。

/** 按 Path 的参数生成这份契约适用的规范清单 */
export function buildStandards({ budgetLines = 0 } = {}) {
  return [
    { code: "E_SCOPE_VIOLATION", rule: "只改任务 scope 内的文件" },
    { code: "E_UNREGISTERED_FILES", rule: "新增文件必须落在 scope 内" },
    {
      code: "E_DIFF_BUDGET",
      rule: budgetLines ? `单个任务改动不超过 ${budgetLines} 行；超了通常是该拆任务` : "单个任务改动不超过预算行数",
    },
    { code: "E_DEP_OR_TEST_TOUCH", rule: "不动依赖与既有测试；新增测试文件不受限（TDD 是正常动作）" },
    { code: "E_TEST_CONFIG_TOUCH", rule: "不动测试配置（runner、覆盖率阈值之类）" },
    { code: "E_LINT_TODO", rule: "不留 TODO / FIXME / HACK 标记；要记就记进任务标题或 issue" },
  ];
}

/** 错误码 → 规范原文；被拦时用来告诉人「违反了哪条」 */
export function ruleOf(code) {
  return buildStandards().find((s) => s.code === code)?.rule ?? null;
}