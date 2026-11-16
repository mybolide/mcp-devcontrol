---
name: devcontrol
description: >-
  本项目的研发纪律：开工先问内核，改代码前 claim，只改 scope 内文件，
  收口由内核在干净检出里重跑验收。所有动作走 devcontrol 工具或 devcontrol CLI。
version: "6.0.0-alpha.1"
---

# devcontrol —— 本项目的研发纪律

这个项目的需求、任务、验收与证据都在 `.devcontrol/state.db` 里，由 devcontrol 内核管。
你要做的事，由内核告诉你，不要自己挑。

## 一轮的唯一流程

1. 开工先问内核：`bootstrap`（MCP）或 `devcontrol status`（CLI）。返回的 `next` 就是你现在该做的那件事。
2. 按 `next.args` **原样执行**（参数是给全的；缺参数会收到 `INVALID_ARGUMENT`）。
3. 改代码只能动 `claim` 返回的 `scope` 里的文件。
4. `devcontrol commit -m "..."`：只提交 scope 内的文件，自动写 Task-Id。
5. `devcontrol close`：内核在**干净检出**里重跑验收，全过才算 done。

## 硬规则（违反会被拦，不是建议）

- 不许改 acceptance、不许自选命令：验收命令在 Owner 批准 Path 时已经冻结。
- 一个任务只改自己的 scope；**scope 相交的任务不能同时开工**。
- 失败过的任务再 close 必须带 `--resolved-by`（一句话：最后怎么解决的）。
- 遇到歧义用 `ask`，不要猜。

## 被拦了怎么办

| 错误码 | 怎么办 |
|---|---|
| `E_NEED_APPROVED` | 需求或 Path 还没批准，等 Owner 在控制台批 |
| `E_CLAIMED_BY_OTHER` / `E_SCOPE_OVERLAP` / `E_WIP_LIMIT` | 等别人收口，或换一个不冲突的任务 |
| `E_NO_DELIVERY` | 还没有本任务的提交，先 commit |
| `E_SCOPE_VIOLATION` | 改了 scope 外的文件，撤掉 |
| `E_ASSERTION_FAILED` | 验收没过，去控制台「证据」看退出码 |
| `E_NEED_RESOLUTION` | 补 `--resolved-by` 再 close |
| `E_MEMORY_CANDIDATE` | 记忆写得太具体，按提示模板改写后再写一次 |

## 多个 Agent 并行时必读

每个 Agent 用**不同的** `DEVCONTROL_ACTOR`（MCP 里传 `actor`）。
两个 Agent 用同一个 actor 名，第二个会被 WIP=1 挡住，要等 45 分钟租约过期才恢复。

## 记忆

`memory` 是**本项目**的经验库（`.devcontrol/memory.db`）：动手前先搜，踩完坑再写。
只写以后还会用到的通则，不写「这次改了第 12 行」。

