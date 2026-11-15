<!-- devcontrol:begin -->
开工先跑 `devcontrol status`：它返回的 next 就是下一件事，不要自己挑。
改代码前必须 task.claim；不许修改 acceptance，不许自选命令；只改 scope 内的文件。
改完 `devcontrol commit -m "..."`（只提交 scope 内文件），再 `devcontrol close`（内核在干净检出里重跑验收）。
遇到歧义用 ask，不要猜。
控制台：需要时自己起 `devcontrol serve`（本模式不注册 MCP，不会自动拉起）。
<!-- devcontrol:end -->
