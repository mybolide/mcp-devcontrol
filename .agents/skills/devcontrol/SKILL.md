---
name: devcontrol
description: >-
  本项目的研发纪律：开工先问内核，改代码前 claim，只改 scope 内文件，
  你的工作是写代码 + 自己跑测试。内核只核验证据：它不替你跑测试，也不猜你有没有跑过。所有动作走 devcontrol 工具或 devcontrol CLI。
version: "6.0.0-alpha.1"
---

# devcontrol —— 本项目的研发纪律

这个项目的需求、任务、验收与证据都在 `.devcontrol/state.db` 里，由 devcontrol 内核管。
你要做的事，由内核告诉你，不要自己挑。

## 一轮的唯一流程

1. 开工先问内核：`bootstrap`（MCP）或 `devcontrol status`（CLI）。返回的 `next` 就是你现在该做的那件事。
2. **原样执行** next：走 MCP 用 `next.args`（缺参数会收到 `INVALID_ARGUMENT`）；走 CLI 就用 `next.cli` 那一行，粘进终端直接能跑。
3. 改代码只能动 `claim` 返回的 `scope` 里的文件。
4. **先自己跑验收**：CLI 用 `devcontrol run -- <契约里的命令>`；走 MCP 就用自己的 shell 跑，然后把结果交给 `evidence.record`（command + exit）。跑几次都行，内核取当前代码上的那份。
5. `devcontrol commit -m "..."`：只提交 scope 内的文件，自动写 Task-Id。
6. `devcontrol close`：内核**不执行测试**，只核验你留下的证据（命令对不对、跑的是不是当前这份代码、退出码满足断言）。

## Owner 的动作不在 MCP 里

MCP 工具列表里**没有**批准需求、放行、打回、改预算这些动作——这是故意的：
Agent 能自己批准自己，纪律就没有意义了。
它们由人来做，有两个地方：控制台（`devcontrol serve`）点，或者人自己在终端敲 `devcontrol approve`。

所以碰到下面这些情况，**不要试、不要绕、更不要自己改库**，直接告诉人去做：

| 你要什么 | 人的动作 |
|---|---|
| 需求/Path 还没批准 | 控制台「收件箱」点批准，或终端 `devcontrol approve FR-001 --path P-001` |
| 想改验收标准 | 「需求」页改（走需求变更，不是改任务） |
| 动了依赖或既有测试被拦 | 「任务」页点放行，写理由（≥12 字） |
| 任务太大超预算 | 「需求」页点预算数字改，或把任务拆小 |
| 验收命令过期（项目换了 test 脚本） | 「需求」页点「重采」 |
| 任务做完但验收过不了 | 只能改到过；放行由人决定 |

控制台地址在 `devcontrol status` 的 `console` 字段；没起来就 `devcontrol serve`。

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
| `E_NO_EVIDENCE` | 还没跑过验收：`devcontrol run -- <命令>` |
| `E_EVIDENCE_STALE` | 跑完之后又改了代码，重跑一次 |
| `E_ASSERTION_FAILED` | 证据里的退出码没过，去控制台「证据」看输出 |
| `E_NEED_RESOLUTION` | 补 `--resolved-by` 再 close |
| `E_MEMORY_CANDIDATE` | 记忆写得太具体，按提示模板改写后再写一次 |

## 多个 Agent 并行时必读

每个 Agent 用**不同的** `DEVCONTROL_ACTOR`（MCP 里传 `actor`）。
两个 Agent 用同一个 actor 名，第二个会被 WIP=1 挡住，要等 45 分钟租约过期才恢复。

## 同类需求怎么复用

- 先看有没有现成模板：`devcontrol flow list`
- 这次做得好，就沉淀下来：`devcontrol flow save <名字> --from FR-001`
- 下次同类需求：`devcontrol flow apply <名字>` 建需求草稿（批准仍由 Owner 做），再照模板拆任务

## 记忆

`memory` 是**本项目**的经验库（`.devcontrol/memory.db`）：动手前先搜，踩完坑再写。
只写以后还会用到的通则，不写「这次改了第 12 行」。

