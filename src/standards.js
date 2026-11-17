// devcontrol — 规范：内核**下发**，但不**执行**
//
// 这是这个工具和 Jira 的分界。Jira 只有验收（功能做对了没），代码写得怎么样靠人 review。
// 我们的场景是 AI 写代码、没人 review，所以必须有人把「代码该写成什么样」说清楚。
//
// 但「说清楚」和「盯着你」是两件事：
//   · 规范随任务下发 —— Owner 批准时看得见，Agent 领任务时拿到同一份
//   · 内核不判违规 —— 它只把事实数出来（改了多少行、动没动测试、留没留标记），
//     判断权留给 Owner。**工作台摆事实，人下结论。**
//
// 唯一继续硬拦的是 scope：那不是「代码质量」，是「这行代码属于哪个任务」的事实问题。
// 内核不判它就没人能判，归属链会断。

/** 规范 + 哪些是硬性的。随 Path 契约冻结、随任务下发 */
export function buildStandards({ budgetLines = 0 } = {}) {
  return {
    // 内核真的会拦的（记账必须，不是质量评判）
    enforced: ["scope"],
    rules: [
      {
        id: "scope",
        text: "只改任务 scope 内的文件；新增文件也要落在 scope 内",
        enforced: true,
      },
      {
        id: "budget",
        text: budgetLines ? `单个任务改动不超过 ${budgetLines} 行；超了通常是该拆任务` : "单个任务改动不超过预算行数",
      },
      {
        id: "tests",
        text: "不动依赖与既有测试；新增测试文件不受限（TDD 是正常动作）",
      },
      {
        id: "testconf",
        text: "不动测试配置（runner、覆盖率阈值之类）",
      },
      {
        id: "todo",
        text: "不留 TODO / FIXME / HACK 标记；要记就记进任务标题或 issue",
      },
    ],
  };
}

/** 收口时把「观测到的」和「规范的」对成一张表 */
export function compareStandards(standards, observations = []) {
  const byId = new Map();
  for (const o of observations) byId.set(o.id, [...(byId.get(o.id) ?? []), o.detail]);
  return (standards?.rules ?? []).map((r) => ({
    id: r.id,
    rule: r.text,
    enforced: Boolean(r.enforced),
    // 没观测到问题 = 这条守住了（对非强制项来说，这就是「看着没问题」）
    touched: byId.get(r.id) ?? [],
  }));
}