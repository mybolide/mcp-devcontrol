<!-- devcontrol:begin — 自动生成，勿手改 -->
开工先跑 `bootstrap`（MCP）/ `devcontrol status`（CLI）：它返回的 `next` 就是下一件事，不要自己挑。
改代码前必须 task.claim；不许修改 acceptance，不许自选命令；只改 scope 内的文件。
改完 `devcontrol commit -m "..."`（只提交 scope 内文件），再 `devcontrol close`（内核在干净检出里重跑验收）。
遇到歧义用 ask，不要猜。
控制台地址在 `devcontrol status` 的 console 字段；MCP 连接时会自动拉起，挂掉会自动重建。
多 Agent 并行时，每个 Agent 用自己的 `DEVCONTROL_ACTOR`，否则会被 WIP=1 挡住。
完整规矩见 `.agents/skills/devcontrol/SKILL.md`。
<!-- devcontrol:end -->
