<!-- devcontrol:begin — 自动生成，勿手改；版本 6.0.0-alpha.2 -->
开工先跑 `bootstrap`（MCP）/ `devcontrol status`（CLI）：它返回的 `next` 就是下一件事，不要自己挑。
改代码前必须 task.claim；**claim 的返回里带着这个项目的上下文**（架构、数据约定、怎么加功能、错误怎么处理），开工前先看它，别自己重新摸索一遍项目。不许修改 acceptance，不许自选命令；只改 scope 内的文件。
**先自己跑** `devcontrol run -- <验收命令>` 留证据；再 `devcontrol commit -m "..."`（只提交 scope 内文件）；最后 `devcontrol close`（只核验证据）。
遇到歧义用 ask，不要猜。
控制台地址在 `devcontrol status` 的 console 字段；接了 MCP 会自动拉起，没接就自己 `devcontrol serve`。
多 Agent 并行时，每个 Agent 用自己的 `DEVCONTROL_ACTOR`，否则会被 WIP=1 挡住。
完整规矩见 `.agents/skills/devcontrol/SKILL.md`。
<!-- devcontrol:end -->
