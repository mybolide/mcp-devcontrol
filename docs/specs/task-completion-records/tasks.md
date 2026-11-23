# 任务清单：任务完成交付记录

## 交付物清单（Scope-lock）
- 交付记录单一模块 `src/completion.js`、一个 append-only SQLite 表及兼容迁移。
- task.close 正常/强制完成路径、查询、CLI/MCP 指引、控制台详情、导出。
- 新回归测试 `test/completion.test.js` 和必要既有夹具更新；规格和架构/双语说明。
- 不新增独立页面、外部依赖或 review 状态；不触碰 T-001 scope 以外文件，不改冻结验收或依赖。
- 新文件建议 ≤500 行；函数 ≤50 行；测试覆盖所有失败路径，禁止占位内容与吞错。

## 任务列表
- [ ] T1（FR-1, FR-2）：实现字段校验、append-only 表、证据快照和正常收口原子事务；覆盖旧库幂等迁移、缺字段/错误类型/超长和事务失败回滚。
- [ ] T2（FR-3）：保存打回后的多轮历史；处理旧 done 任务未记录态与 force-close 原因；测试不得伪造 runs/commits。
- [ ] T3（FR-4, FR-5）：store 查询投影、MCP/CLI 参数和 close 返回、task show、console 展开、Markdown export、技能指引及安全转义。
- [ ] T4（FR-1..FR-5）：执行冻结验收 `npm test`、`npm run build`、`npm run packcheck`，审查增量 diff 并记录 revision 与原始输出。

## 文件变更清单
- 数据与门禁：`src/db.js`、`src/completion.js`、`src/gates.js`、`src/store.js`。
- API/指引：`src/cli.js`、`src/mcp.js`、`src/digest.js`、`src/nextcmd.js`、`src/skill.js`、`src/hints.js`。
- 展示/导出：`public/index.html`、`src/report.js`（若新增查询需调整；否则不改）。
- 验证/说明：`test/completion.test.js`、必要既有测试与 helpers、`docs/04-v6-architecture.md`、`README.md`、`README.zh-CN.md`。
- 规格：`docs/specs/task-completion-records/requirements.md`、`design.md`、`tasks.md`。

## 验收命令
- `npm test :: exit==0`
- `npm run build :: exit==0`
- `npm run packcheck :: exit==0`

## 需求覆盖矩阵
| 需求 | 任务 | 验收 |
|---|---|---|
| FR-1 | T1,T4 | AC-1,AC-5 |
| FR-2 | T1,T4 | AC-2,AC-5 |
| FR-3 | T2,T4 | AC-3,AC-4,AC-5 |
| FR-4 | T3,T4 | AC-4,AC-5 |
| FR-5 | T3,T4 | AC-1,AC-5 |

## 完成证据
每项测试记录实际命令、退出码与通过数量；记录最终 revision 和真实变更文件。最终 task.close 必须写交付结论、主要改动、遗留限制；报告人工 review 与门禁验收时严格区分。
