[English](README.md) | **简体中文**

# devcontrol

给编码 Agent 用的纪律内核。

它让 Claude Code / Codex / Cursor / OpenCode 按同一套规矩干活：改代码前先领任务，只改这个任务范围内的文件，交活时得拿出跑过的证据。内核只核对证据 —— **它不替你跑测试**。

你只做三件事：**收件、批准、放行**。剩下的路 Agent 自己走完。

## 它解决什么

Jira 管需求。但没人管 Agent 到底干了什么。

- 它说「测试都过了」。跑了吗？
- 一个 bug 在 A 层，它去改 C 层。
- 已经有的工具函数，它又抄了一份。
- 两个 Agent 并行，互相把对方的改动盖掉。
- 两周后没人说得清这行代码属于哪个任务。

## 用了之后

| 之前 | 之后 |
|---|---|
| 「测试过了」——只能信 | 一条记录：命令、退出码、输出，外加当时代码的指纹。跑完再改代码，证据立刻作废 |
| 它自己决定改哪些文件 | 越界的文件直接拒。只有这一道硬拦，别的都不拦 |
| 每个任务重新摸索一遍项目 | 架构和约定写一次，**自动跟着每个任务下发** |
| 说不清某行代码是谁写的、为什么写 | 每个提交带着任务号。「这行为什么存在」有答案 |
| 全程盯着 | 只回答三个问题：批不批、要不要做、卡住了怎么办 |
| 「这工具到底有用吗」 | `devcontrol stats` / `report`：拦了多少次、返工几轮、还是从来没敢说不 |

## 三步开始

```bash
npm install -g mcp-devcontrol     # 需要 Node >= 22.5、git >= 2.30
cd 你的项目
devcontrol init
```

`init` 建好状态库、按目录冻结契约草稿、写下 `.mcp.json`（MCP 的通用入口，Claude Code 等直接读它），再往 `AGENTS.md` 里写一段规矩。客户端**私有**配置按需生成：项目里已经有 `.cursor/`、`opencode.json` 或 `.opencode/` 时才给对应客户端各写一份；想显式要就 `devcontrol init --mcp-for cursor,opencode`（或 `all`）。Codex 的配置要手动加一段，`init` 会把那段原样打出来。

然后（在 Agent 会话里，或者终端里）：

```bash
devcontrol intake "把首页标题改成人话" --accept "npm test :: exit==0"   # 你
devcontrol approve FR-001 --path P-001                                 # 你
devcontrol next                                                        # 内核说下一步做什么
```

不想接 MCP？`devcontrol init --no-mcp`，同样的门禁、同样的证据链，全在终端里。
`init` 还会在项目里落三个版本锁入口：`.devcontrol/bin/devcontrol`（Windows 是 `devcontrol.cmd`）。客户端掉了 MCP 工具、CI 里没装 devcontrol，都用它——敲下去打的是同一套内核，不需要 node_modules，也不需要联网。

发布物是**一个自包含文件**：`npm run build` 把内核和依赖压成 `build/devcontrol.js`，装完即跑，SDK 换代不会把老版本装崩。

## 一个任务长什么样

```text
bootstrap        → 「认领 T-003，范围 src/，跑 npm test」
task.claim       → 返回这个任务的范围、验收命令，还有你的项目上下文
   ……写代码……
devcontrol run -- npm test      → 记成证据：命令、退出码、代码指纹
devcontrol commit -m "..."      → 只提交范围内的文件，带上任务号
devcontrol close                → 核对证据并收口。它不跑测试
```

收口会失败，如果：没证据、证据是在别的代码上跑的、命令不在契约里。补一步就好，不算返工。

## 它为什么这么小

这类工具最后都会长成「帮你管环境」的样子。这个不：

- **它不跑你的测试。** 一旦开始跑，它就得管依赖安装、超时、进程回收、干净检出，然后跟你项目的真实工作方式打架。Agent 跑，内核只核对证据和代码对不对得上。
- **只有 scope 是硬拦。** 一行代码写得好不好，是判断；这行代码属于哪个任务，是事实。内核只管事实。
- **规范照着念，不盯着执行。** 改动超预算、留了 `TODO`、动了既有测试 —— 收口时数出来告诉你，怎么处理你自己定。
- **它不替你写文档正文。** 它知道一个项目该有哪几篇说明、会催你写，但内容由 Agent 填 —— 内核不认识你的业务，硬写就是空话。

诚实说清楚它的边界：证据是 Agent 自报的。它能抓住「跑完又改代码」和「没跑就收口」，但**抓不了蓄意伪造**。这工具管流程，不管人品。

## Agent 能调什么

一个 MCP 工具 `devcontrol`，用 `action` 区分：

| action | 干什么 |
|---|---|
| `bootstrap` | 从这里开始。返回 `next`（内核排好的下一件事）、待回答的问题、控制台地址 |
| `wait` | 内核说等，只看当前状态 |
| `task.work` | 该你干活了，返回四步顺序 |
| `path.create` | 创建待 Owner 审批的 Path 草案（不授予写权限） |
| `task.create` | 拆任务（范围、验收、依赖） |
| `task.claim` | 领任务（45 分钟租约，一次一个） |
| `task.renew` | 长任务续租 |
| `evidence.record` | 把你自己在 shell 里跑出来的结果交上来 |
| `task.close` | 收口：核对证据 |
| `task.rework` | 自己重试挂起的任务（失败是自己的就自己改，合同不变，次数有上限） |
| `task.status` | 一条查询拿全：状态、验收结果、失败与返工历史 |
| `task.resume` | 崩溃恢复：释放过期租约，让别人能接手 |
| `bug.report` | 报 Bug，带复现步骤 |
| `ask` | 有歧义就问，别猜 |
| `memory.write` | 记一条经验 |
| `memory.search` | 查这个项目的记忆 |
| `release.create` | 建一个发布 |
| `release.plan` | 把任务挂进发布 |
| `release.ship` | 任务全做完才发布、打 tag |

不接 MCP 的客户端用 CLI，一回事：

```bash
devcontrol status                 # = bootstrap
devcontrol path create --req FR-003 --allow docs/a.js --allow-new-files --budget 600 --test "node --test test/a.test.js"  # 只建草案，Owner 审批后才生效
devcontrol run -- npm test        # 跑一次并留证据
devcontrol commit -m "feat: ..."  # 提交范围内的文件
devcontrol close                  # 核对并收口
devcontrol task abandon T-003 --reason "这条不做了"
```

## 任务完成时要留下交付结论

收口不是「跑过了就算完」。`devcontrol close` 现在必须写清三件事，记进 `.devcontrol/state.db` 的 `task_completions`（只增不改）：

```bash
devcontrol close T-003 \
  --summary "首页标题改成一句话能读懂" \
  --changes "只动 Hero 组件与它的文案常量" \
  --limitations "移动端字号还没在真机验过"
```

- 说明只是说明：证据仍然是内核要核验的那几条 run（命令、退出码、跑在哪份代码上）。
- 打回后再完成不是覆盖，是**追加**一条；`devcontrol task show T-003` 看历次结论与证据，`devcontrol export` 里也有一节。
- 旧任务没有这段记录就显示「未记录」，不事后补造。
- Owner 点「放行」强制完成也会留一条，但标明「强制完成（未经验收）」，跟验收通过区分开。
- 完成 ≠ 人工 review 通过：内核只证明门禁过了。

## 控制台是白送的

接上 MCP，本机就会出现一个控制台 `http://127.0.0.1:7373`：收件箱、需求、Bug、任务、发布、记忆、文档、证据、设置。它自己启动、崩了自己重建、也不会去杀别的项目的实例。你不用管它。

## 它不是什么

- 不是看板。没有泳道、没有冲刺、没有负责人。
- 不是 linter。不会说你代码丑。
- 不是测试运行器。
- 不是多用户。就一个 Owner，没有账号体系。
- 不是规则引擎。五条规范，只有一条会拦。

## 想看细节

- `docs/03-discipline-core.md` —— 每一条规矩，以及为什么
- `docs/04-v6-architecture.md` —— 设计和取舍
- `devcontrol --help` —— 所有命令
- `devcontrol doctor` —— 拿仓库和库对账，没问题时一个字都不说

MIT.