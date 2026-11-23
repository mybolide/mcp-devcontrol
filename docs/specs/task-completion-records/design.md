# 任务完成交付记录设计

## 概述
本设计覆盖 FR-1 至 FR-5。交付说明是完成时的结构化快照，不是测试结果，也不是人工 review 判定。现有证据、提交归属和 scope 门禁保持不变。

## 技术方案
- **FR-1 字段校验**：新增纯函数校验 `summary`、`changes`、`limitations` 的类型、trim 后非空及长度上限。缺字段返回 `E_NEED_COMPLETION`，列入环境/用法错误，不增加 `review_round`。
- **FR-2 持久化**：新增 `task_completions` append-only 表，保存任务 ID、轮次、actor、收口类型、时间、三项说明、指纹、`runs_json`、`commits_json`。在 `taskClose` 已完成所有慢速 Git/证据检查后，用同一 SQLite 短事务完成 closing token CAS、task done、completion insert、patch_ids 和 close event。事务内不运行 Git/网络。
- **FR-3 历史和强制完成**：每次 Owner reopen 后再次成功 close 都插入新行，禁止 update/delete 历史。`listTasks/getTask` 读取全部记录并暴露最新记录；旧任务数组为空。`force-close` 从 Owner override reason 建立独立记录，`closed_by=force-close`、runs/commits 为空，绝不标记为 evidence passed。
- **FR-4 查询和展示**：统一 store mapper 为 CLI `task show`、MCP 返回、控制台 state、`exportMarkdown` 提供同一记录数据。控制台以 `<details>` 展开历史，所有自由文本经 `esc()`；Markdown 导出字段按固定表格编码，避免换行/分隔符污染结构。
- **FR-5 指引**：更新 `task.close` MCP schema、INSTRUCTIONS、CLI help、`next` 步骤及 Skill，列出需提交的字段，并明确完成不等于人工 review 通过。

## 文件结构
- `src/db.js`：SCHEMA_VERSION 加一，创建 append-only `task_completions` 与查询索引。
- `src/completion.js`：说明校验、限长、事务插入及历史读取的单一事实源。
- `src/gates.js`：正常 close 原子保存；已有门禁失败不创建成功行。
- `src/store.js`：任务查询附加 completion history；Owner force-close 原因留存。
- `src/cli.js`、`src/mcp.js`、`src/digest.js`、`src/nextcmd.js`、`src/skill.js`、`src/hints.js`：输入、返回和操作指引。
- `public/index.html`：任务详情展开及安全渲染。
- `test/completion.test.js` 与现有 `test/`：迁移、验证、历史与展示回归。
- `docs/specs/task-completion-records/`、`docs/04-v6-architecture.md`、双语 README：规格和用户说明。

## 数据迁移、兼容性与事务
现有 schema v4 升级至 v5。建表和索引使用幂等 DDL。历史 done 任务不回填。唯一成功写入点位于 `taskClose` 收尾事务：所有证据、scope、提交检查和 contextNote 检查完成之后；若事务失败，task.done、completion、close event 一并回滚。并发重复 close 仍由 closing token CAS 拦截。

## 安全与边界
API 输入先做 `typeof value === "string"`，再 trim 和限长，避免任意输入触发未处理 TypeError。控制台用文本转义，禁止将交付文字直接作为 HTML。证据快照只从本次已核验的 `runs` 与 owned commits 构建，拒绝客户端注入“验证通过”状态。force-close 明确为 Owner 强制操作，不算测试通过。

## 对应需求
- FR-1、FR-2：`src/completion.js`、`src/gates.js`、`src/db.js`
- FR-3：`src/completion.js`、`src/store.js`、`src/console.js`
- FR-4：`src/store.js`、`src/cli.js`、`src/mcp.js`、`src/report.js`、`public/index.html`
- FR-5：`src/mcp.js`、`src/digest.js`、`src/nextcmd.js`、`src/skill.js`、`src/hints.js`
