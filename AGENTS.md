<!-- mcp-probe:context begin — auto-generated; re-run init_project_context updates this block only -->
<!-- mcp-probe:context-version: 4.0.3-rc.1 -->
## MCP (call first)
Requires mcp-probe-kit. Before coding, read Skill: @.agents/skills/mcp-probe-kit/SKILL.md (or [When to call MCP](.agents/skills/mcp-probe-kit/SKILL.md)) (Skill file auto-created on first MCP call).

- User says only “continue / start / keep going” → **call `resume_plan` first**; pass `plan_id` when known, otherwise pass only `project_root` to recover the latest active/blocked Plan. Do not explore with Bash, call `workflow`, or restart with `start_*` until no resumable Plan is confirmed. When recovery returns `mustContinue=true`, do not stop after reporting recovery; execute `nextStep/nextTool` immediately, call `plan_heartbeat` after each step, and continue until blocked, cancelled, or converged
- Unsure which MCP → `workflow` (returns a tool-selection guide only; the Agent decides, and clarifies only when needed)
- MCP tools missing from this Agent session → follow the Skill CLI fallback and call `.mcp-probe-kit/bin/probe.*`; do not ask the user to install it
- Feature → `start_feature` (searches memory first)
- Bug → `start_bugfix` (searches memory first)
- UI → `start_ui` (searches memory first)
- Unfamiliar code / impact → `code_insight` (context / impact / auto)
- Missing context → `init_project_context`
- Commit → `gencommit`

Context: read [project-context](./docs/project-context.md) after Agent creates it (`init_project_context` + templates)
Graph: read [latest](./docs/graph-insights/latest.md) after Agent saves code_insight output (save_to_docs=true)
Memory (requires MEMORY_* env):
- Search: `start_*` auto-injects full memory hits; use `search_memory` mid-task; `read_memory_asset` for a specific id
- Store: do NOT use source_project/source_path for cross-repo pools; put paths in content; write keyword-rich summary
- Update: fix existing entries in place with `update_memory_asset` by asset_id (preserves ID)
- Cleanup: remove stale/wrong/duplicate entries with `delete_memory_asset` (confirm via `read_memory_asset` first)
- After each verification, prepare successful or negative memory candidates and record them in `plan_heartbeat`; persist with `memorize_asset` only after `converge` passes
- For reusable feature/UI output, prepare a candidate first; after convergence persist it as `pattern`/`component`
<!-- mcp-probe:context end -->

<!-- devcontrol:begin — 自动生成，勿手改；版本 6.0.0-alpha.7 -->
开工先跑 `bootstrap`（MCP）/ `devcontrol status`（CLI）：它返回的 `next` 就是下一件事，不要自己挑。
改代码前必须 task.claim；**claim 的返回里带着这个项目的上下文**（架构、数据约定、怎么加功能、错误怎么处理），开工前先看它，别自己重新摸索一遍项目。不许修改 acceptance，不许自选命令；只改 scope 内的文件。
**先自己跑** `devcontrol run -- <验收命令>` 留证据；delivery=code 再 `devcontrol commit -m "..."`（只提交 scope 内文件），delivery=verify 不提交；最后 `devcontrol close`（只核验证据）。
遇到歧义用 ask，不要猜。
控制台地址在 `devcontrol status` 的 console 字段；接了 MCP 会自动拉起，没接就自己 `devcontrol serve`。
多 Agent 并行时，每个 Agent 用自己的 `DEVCONTROL_ACTOR`，否则会被 WIP=1 挡住。
完整规矩见 `.agents/skills/devcontrol/SKILL.md`。
<!-- devcontrol:end -->
