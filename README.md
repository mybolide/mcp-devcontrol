# devcontrol v6 — 研发纪律内核

让 Claude Code / Codex CLI / Cursor / OpenCode 这些编码 Agent 在**同一套规则**里干活：
改代码前必须领任务、只能改 scope 内的文件、交付必须能在一个干净检出里重跑通过。
人只做三件事：**收件、批准、放行**；工序由 Agent 自己走完。

- **从 mcp-probe-kit v5 迁移记忆**：`node scripts/v5-import.mjs --qdrant http://127.0.0.1:6333 --collection <v5集合>`（默认 dry-run，加 `--write` 才落库）。
- **下一步由内核决定**：`bootstrap.next` 按「收口 > 依赖已满足的 backlog > 补齐未覆盖的验收 > 等阻塞」排序；人只负责批准和放行。
- 事实源只有一份：`.devcontrol/state.db`（SQLite 单文件，WAL）。**不用 md 当事实源**，`devcontrol export` 只是只读快照。
- 契约真源在 git：`.devcontrol/contracts/<pathId>.json`，Owner 批准时写入并提交，Agent 只读。
- 这是**独立项目**（`mcp-devcontrol`）。`mcp-probe-kit` 的 v4/v5 保持原样、原包名、原 MCP 身份，互不影响：能用 `devcontrol` 的地方不需要卸载 v4。
- 血缘：v6 的设计是从 mcp-probe-kit v5 的实验里收敛出来的（v5 是过渡版，已冻结），但身份、包名、数据目录、MCP 注册名全部独立。
- 迁移：v5 的坑库用 `scripts/v5-import.mjs` 读 Qdrant 导进来，不影响 v5 本身。
- 纪律判定口径见仓库内 `docs/03-discipline-core.md`（v8.8），v6 的取舍/协议/分期见 `docs/04-v6-architecture.md`（这两份随仓库走，不进 npm 包）。

---

## 1. 安装

```bash
# Node ≥ 22.5（需要内置 node:sqlite 的 DatabaseSync），git ≥ 2.30
node -v && git --version
npm install          # 唯一依赖：@modelcontextprotocol/sdk

cd devcontrol
npm link            # 之后任意目录可用 devcontrol
# 或者不 link，直接用绝对路径：node /path/to/devcontrol/bin/devcontrol.js ...
```

无需 build；运行时依赖只有官方 `@modelcontextprotocol/sdk`（协议层），业务与存储全部用 Node 内置模块（`node:sqlite` / `node:http` / `node:child_process`），不联网。

## 2. 在项目里初始化

**两种接入方式，任选**：

| 方式 | 命令 | 得到什么 | 代价 |
|---|---|---|---|
| MCP（推荐） | `devcontrol init` | Agent 在会话里直接调 `devcontrol` 工具；控制台随连接自动拉起；纪律随 `instructions` 下发 | 要在客户端注册一次（init 帮你写四端配置） |
| 纯 CLI | `devcontrol init --no-mcp` | 同样的门禁与证据链，Agent 走 `devcontrol status/commit/close` | 控制台要自己 `devcontrol serve`；工具说明靠 `AGENTS.md` |

**MCP 不是必需的**：内核的状态、契约、门禁、证据全在 `.devcontrol/state.db` + git 里，CLI 与 MCP 走的是同一套函数。MCP 只是让 Agent 不必调 shell，并把控制台生命周期挂上去。

### 初始化细节

```bash
cd <你的仓库>
devcontrol init
```

`init` 做五件事：

1. 建 `.devcontrol/`（`state.db` / `contracts/` / `runs/`），并把 `state.db*`、`runs/`、`r2-wt/` 写进 `.gitignore`。
2. 为仓库里每个顶层目录建一条 **Path 草稿**（`allowed_paths` + 预算 + 测试命令），状态 `draft`，等 Owner 批准。
3. 写四端 MCP 配置（指向本机的 `bin/devcontrol.js`，并带上 `DEVCONTROL_ROOT`）：
   `.mcp.json`（Claude Code）、`.cursor/mcp.json`（Cursor）、`opencode.json`（OpenCode）；Codex 的 `~/.codex/config.toml` 片段会打印出来，手动贴一次。
4. 在 `AGENTS.md` 里追加一段 `<!-- devcontrol:begin -->` 标记块，告诉 Agent 先 `bootstrap`、改代码前 `claim`、不许改验收。
5. 不需要你启动控制台：客户端一连上 MCP，控制台就会自动拉起/复用（见 3.3）。

`init` 会把上面这些自己写的文件**提交**成 `chore(devcontrol): init`，否则第一次 `close` 会被 `E_DIRTY_SCOPE` 拦住。
仓库被移动/复制后再跑一次 `init`：检测到 `.mcp.json` 里的 `DEVCONTROL_ROOT` 指向旧路径会**自动按新路径重写**，并保留你其他的 MCP server。

## 3. 两条工作流

### 3.1 Agent（MCP 或 CLI 等价）

MCP 只有一个工具 `devcontrol`，十三个动作（`wait` 是 `next` 告诉你「现在别动手」时唯一可调的动作）：

| action | 用途 | 关键约束 |
|---|---|---|
| `wait` | 内核说等（等批准/等前置/等 Owner）时用；只返回当前状态 | 不改变任何状态 |
| `bootstrap` | 开局定向：**`next`（内核排好的下一件事）** + `actions` + `plan`（未覆盖的验收）+ 控制台地址 | 第一个动作必须是它；照 `next` 做，不自己挑 |
| `task.create` | 拆任务（scope / 验收 / 依赖 / 预算） | 验收命令必须落在 Path 契约白名单内 |
| `task.claim` | 领任务（45 分钟租约，WIP=1） | 与其他在办任务 scope 相交会被拒 |
| `task.renew` | 续租：长任务超过 45 分钟时续一次（`commit` 等写操作也会自动续） | 租期已被回收 → `E_CLAIM_STALE`，必须重新 `task.claim` |
| `task.close` | 收口：R0–R5，干净检出里重跑验收 | 有交付提交、全部断言 exit 0 才 `done` |
| `bug.report` | 报 Bug（现象 + 复现步骤） | 不能直接改代码 |
| `ask` | 歧义就问，不猜 | 问完任务 `parked`，Owner 回答后回到队列 |
| `memory.write` | 随时记一条通用经验（坑 / 解法 / 约定 / 片段） | 不合格会进隔离区并给出改写模板 |
| `memory.search` | 查本项目记忆 | 只读；命中累计 `hits` |
| `release.create` / `release.plan` / `release.ship` | 发布：一组任务全 done 才能 ship | 空发布 / 有未完成任务都会被拦 |

CLI 等价（不接 MCP 的客户端用这条）：

```bash
devcontrol status                     # = bootstrap
devcontrol commit -m "feat: ..."      # 只提交 scope 内文件，自动写 Task-Id / DevControl-Base trailer
devcontrol renew                      # = task.renew（续 45 分钟租约；commit 也会自动续）
devcontrol close                      # = task.close（默认取当前 actor 手上唯一在办任务）
devcontrol run -- npm test            # 采证执行，记录退出码与耗时
```

Agent 的典型一轮：

```text
bootstrap → task.claim(T-003) → 改代码 → devcontrol commit -m "..." → task.close
                                                          ↑ 内核在 .devcontrol/r2-wt 干净检出里重跑验收
```

### 3.2 Owner（只在控制台）

控制台**不用你自己起**：MCP 连上就自动拉起（见 3.3）。要手动常驻也可以：

```bash
devcontrol serve            # 前台常驻，http://127.0.0.1:7373
devcontrol serve --stop     # 停掉本项目自己的控制台（不会误杀别的项目）
```

十三个 Owner 动作，**只在控制台**（`release.ship` 例外，MCP 也能调）：

`intake`（收需求/Bug）、`approve`（需求 + Path 一起冻结并提交契约）、`amend`（改验收或路径，在办任务自动回 backlog）、
`adjust`（改 scope/预算）、`reopen`（打回）、`decide`（Bug 采纳/驳回）、`answer`（回答问题，任务回队列）、
`override`（放行某个拦截码，一次性；或`force-close`）、`handoff`（生成交接卡，可粘给另一个 Agent）。

控制台是六个视图（侧栏切换）：**收件箱**（待批准需求 / 待回答提问 / 待裁决 Bug / parked 任务 / 待提炼记忆）、**任务与覆盖**、**发布**、**记忆**、**文档**、**证据**（每次重跑的命令/退出码/HEAD/指纹）。

### 3.2b 两台电脑：局域网访问控制台

默认只听回环（`127.0.0.1`），别的机器连不上。要从另一台电脑打开：

```bash
devcontrol serve --host 0.0.0.0
# devcontrol 控制台：http://127.0.0.1:7373
#   局域网（另一台电脑直接打开）：http://192.168.0.107:7373/
#   同一局域网的人都能打开。用完 devcontrol serve --stop 就断。
```

就这样，没有令牌、没有登录、没有额外一步。

想加固就设一个环境变量，设了才校验：

```bash
DEVCONTROL_OWNER_TOKEN=随手定一串 devcontrol serve --host 0.0.0.0
# 之后打开 http://192.168.0.107:7373/?token=随手定一串
# 页面把令牌存 localStorage 并放进 X-Owner-Token 头（不用 cookie，别的站点发的请求带不上）
```

始终保留的一条边界：Host 只认回环和本机网卡地址，陌生 Host 一律 403（挡 DNS rebinding）——它零成本，且挡的是不需要你配合就能发生的攻击。

不想开端口也行，SSH 隧道等价且不暴露局域网：
`ssh -L 7373:127.0.0.1:7373 you@192.168.0.107`，然后在本机开 `http://127.0.0.1:7373/`。

### 3.3 控制台由 MCP 全权托管（和 v5 一样，人不用启动也不用重启）

MCP 连接就是控制台的生命周期触发器。`runMcp` 启动时调用 `ensureConsole(root)`：

1. 拿本项目锁 `.devcontrol/console.lock`（`wx` 独占创建，持锁进程死了或超过 30s 自动回收），并发 MCP 不会被互相踩；
2. 从 `DEVCONTROL_PORT`/`7373` 起逐个探测 `GET /api/meta`：
   - **是本项目自己的实例** → `SIGTERM` 杀掉、等端口释放，再用当前代码重启（同一端口）。这样升级后不会留旧进程在跑；
   - **是别的项目** → 绝不杀，换下一个端口；
   - **被非 devcontrol 服务占着** → 换下一个端口；
   - **空端口** → 直接起；
3. 新进程 `detached`，日志在 `$TMPDIR/devcontrol-console-<项目哈希>.log`，MCP 退出不影响页面；
4. `bootstrap` 把地址放进 `console` 字段，Agent 转告 Owner；`AGENTS.md` 里已写明。

没有人需要按的那几个按钮：

- **不用启动**：MCP 连上就有；
- **不用重启**：控制台被停掉/崩了，下一次 `bootstrap` 发现地址死了就**就地重建**（自愈）；
- **不用刷新页面**：控制台页面每 4s 自轮询，断线时显示「重连中…」，恢复后自己回到「已连接」；
- **不会互相杀**：刚起来 10s 内的自己人复用不重启（`DEVCONTROL_RESTART_GRACE_MS`），避免多个 MCP 连续启动把页面刷来刷去。

两个刻意的取舍：

- **独立进程**：MCP 重启不打断阅读；代价是进程活到你 `devcontrol serve --stop` 或重启机器。
- **没有实例注册表**：v5 还维护 `workspace-runtime` 记录 + 版本握手，devcontrol 只靠 `/api/meta` 里的 `root/pid/startedAt` 做身份判断——少一个可能失配的状态文件。


开关：`DEVCONTROL_CONSOLE=0` 关掉自动拉起；`DEVCONTROL_PORT=<n>` 换起始端口；`DEVCONTROL_RESTART_GRACE_MS=<ms>` 调宽限期。

### 3.4 项目记忆（memory）

**记忆是「这个项目自己的」**：踩过的坑、定下的约定、用过的解法，跟着仓库走。跨项目共享是以后同步到远程的事，不是本地默认行为。

- 真源是本仓库的 `.devcontrol/memory.db`（一张 `pitfalls` 表，不进 git）；Qdrant 只是**可重建的向量索引**，挂了不丢数据。
- 写：`memory.write` 随时可用（不要求有任务）；`task.close` 失败过必须带 `resolvedBy`（否则 `E_NEED_RESOLUTION`），内核自动记一条 pitfall。
- **不是所有问题都配进库**：内容太短、没有可观测信号、解法是一次性手滑（拼写/漏文件/改名）、写死本项目私有路径 → 进**隔离区**（`candidate`），不建索引、不召回；`devcontrol memory promote M-xxx` 才晋升。标题相同自动去重。
- 读：`bootstrap.memories` 注入当前任务命中的 top 3；`memory.search` 显式查。
- 不合格不是丢掉：命中隔离区时返回 `E_MEMORY_CANDIDATE` + 模板「当出现 X 时，用 Y（原因：Z）」，按模板用 `kind=howto` 重写一次即入库。
- 去重：标题相同直接合并；向量可用时按相似度（默认 ≥0.9）合并，不新增条目。
- 控制台收件箱会列出「待提炼的记忆」，改一句话点「收进记忆」即晋升并建索引。
- 降级：向量栈不可用 → 关键词检索（中文 bigram + LIKE），收口照常通过，`doctor` 报 `MEMORY_INDEX_FAILED`。

```bash
devcontrol memory status                    # 有多少坑、索引状态、连的哪个 embedding/Qdrant
devcontrol memory search "worktree 提交丢失"  # 在本项目记忆里检索
devcontrol close --resolved-by "r2-wt 是 detached，提交后要 cherry-pick 回主分支"
devcontrol memory reindex                   # 向量库重建（数据不丢）
devcontrol release create "v0.1" --target 2026-12-01   # 发布：plan 挂任务，ship 全部 done 才放行
devcontrol release plan R-001 T-003 T-004
devcontrol release list
```

| env | 默认 |
|---|---|
| `MEMORY_EMBEDDING_PROVIDER` / `MEMORY_EMBEDDING_URL` / `MEMORY_EMBEDDING_MODEL` | `ollama` / `http://127.0.0.1:11434` / `nomic-embed-text` |
| `MEMORY_QDRANT_URL` / `MEMORY_QDRANT_COLLECTION` | `http://127.0.0.1:6333` / `devcontrol_memory_<项目路径前8位>` |
| `DEVCONTROL_MEMORY` / `DEVCONTROL_MEMORY_DB` | `on` / `<项目>/.devcontrol/memory.db` |

## 4. 拦截点（这就是"法"）

`task.close` 按顺序判定，任一失败即返回错误码并写事件：

| 阶段 | 检查 |
|---|---|
| R0 | 区间内有没有交付提交；有没有**无主提交**（既没有本任务 trailer、也不是他人带 trailer 的正常提交） |
| R1 | 越界文件、未登记新增文件、行数预算（任务级 + Path 累计）、新增 TODO 未带任务号、改测试配置、改依赖/测试目录 |
| R2 | 在 `.devcontrol/r2-wt` 干净检出中逐条重跑验收断言（600s 超时，`node_modules` 通过软链复用） |
| R3 | 重跑期间 HEAD 或 scope 指纹漂移 → `E_EVIDENCE_DRIFT` |
| R4 | 归属提交不在 HEAD 祖先链上 → `E_UNMERGED_WORK` |
| 收口 | 状态 CAS 写入 `done`；消费一次性 waive；写 `close` 事件 |

失败计数规则：环境类（`E_DIRTY_SCOPE` / `E_BUSY` / `E_TIMEOUT`）**不计** `review_round`；其余失败累计，3 次自动 `parked`，等 Owner `reopen`。

### 失败长什么样（Agent 靠这个分支处理）

**成功和失败都是 stdout 上的 JSON，`ok` 字段必在**。失败时一定带 `code` 和 `hint`：

```json
{ "ok": false, "code": "E_DEP_OPEN", "message": "前置 T-001 未完成",
  "data": { "dep": "T-001", "status": "doing" },
  "hint": "前置任务还没收口。先把它做完（devcontrol close），或者换一个不依赖它的任务。" }
```

- `message` 说**哪里**错了，`data` 放机读细节（越界的文件名、允许的命令列表…），`hint` 说**下一步做什么**。
- stderr 只放人读的两行（`code: message` + `→ hint`），可以整段丢掉不影响程序。
- 退出码：`0` 成功 / `1` 动作被拒 / `2` 用法写错。**不是用法错误就别给 2**，否则脚本分不清「你敲错了」和「内核不让」。
- 每条会返回给 Agent 的错误码都必须有 hint；`test/failure-contract.test.js` 会从源码里扫出所有错误码逐条核对，漏一个就红。

### 错误码

| 码 | 含义 |
|---|---|
| `E_NOT_REPO` / `E_SCHEMA_NEWER` / `E_ID_EXHAUSTED` | 环境与版本 |
| `E_NEED_APPROVED` / `E_NO_CONTRACT` / `E_CONTRACT` / `E_HASH_MISMATCH` | 契约没批、契约缺失、契约被改、哈希不符 |
| `E_ILLEGAL_TRANSITION` / `E_CLAIM_STALE` / `E_CLAIMED_BY_OTHER` / `E_WIP_LIMIT` / `E_SCOPE_OVERLAP` / `E_DEP_OPEN` | 状态与并发 |
| `E_SCOPE_TOO_BROAD` / `E_FILE_TOO_LARGE` | 任务切分过大 |
| `E_UNOWNED_COMMIT` / `E_NO_DELIVERY` | 提交归属 |
| `E_SCOPE_VIOLATION` / `E_UNREGISTERED_FILES` / `E_DIFF_BUDGET` / `E_LINT_TODO` / `E_TEST_CONFIG_TOUCH` / `E_DEP_OR_TEST_TOUCH` | R1 |
| `E_ASSERTION_FAILED` / `E_TIMEOUT` / `E_EVIDENCE_DRIFT` / `E_UNMERGED_WORK` | R2–R4 |
| `E_DIRTY_SCOPE` / `E_BUSY` | 环境类，不计轮次 |
| `E_USAGE` / `INVALID_ARGUMENT` | 命令或参数写错（`E_USAGE` 退出码 2） |
| `E_NO_TASK` / `E_WEAK_NO_GIT` / `NOT_FOUND` | 手上没任务、弱模式不能提交、找不到那个编号 |
| `E_INTERNAL` | 兜底 |

## 5. 数据模型（9 表 + meta）

`requirements` `paths` `tasks` `bugs` `docs` `questions` `events` `runs` `patch_ids`，外加 `meta`（schema 版本、单调 ID 计数器、一次性 waive 标记）。

- ID 单调递增不复用：`FR-xxx` / `P-xxx` / `T-xxx` / `B-xxx` / `Q-xxx` / `D-xxx`。
- `runs` 存每次验收重跑的命令、退出码、HEAD、指纹、输出（截断 20k）、耗时——可复核。
- 唯一可写入口是内核函数；库里出现 `done` 却没有 `close` 事件，`devcontrol doctor` 会报 `GHOST_DONE`。

## 6. 自检

```bash
npm test            # 166 条集成测试，真的建临时仓库、真的跑 close、真的起 MCP 与控制台，不 mock
devcontrol doctor   # 出问题才说话；有 ERROR 时退出码 1
devcontrol export   # markdown 快照（只读，别拿去改状态）
```

`doctor` 分两组，职责不同：

**「Agent 做了什么」**（对账仓库与库）

| 码 | 含义 |
|---|---|
| `GHOST_DONE` | 库里 done 但没有收口事件（疑似直接改库） |
| `STALE_CLAIM` / `STALE_CLOSING` | 租约过期 / 收口卡住 |
| `STALE_PATH` / `TEST_CMD_DRIFT` | Path 指向的目录没了 / 冻结的验收命令已过期 |
| `DOC_DRIFT` / `SKILL_OUTDATED` / `DIRTY_TREE` | 文档变了没登记 / Agent 说明过期 / 工作树脏 |
| `OVERRIDDEN` / `WEAK_MODE` | Owner 放行过的收口 / 弱模式没有提交链 |

**「内核自己有没有前后矛盾」**（只看库，不看仓库）

| 码 | 含义 |
|---|---|
| `NO_APPROVED_PATH` | 有已批准的需求，但一条已批准的 Path 都没有 |
| `ACCEPTANCE_NOT_IN_CONTRACT` | 需求批准过的验收命令，没有任何已批准 Path 冻结它 |
| `TASK_ASSERTION_DRIFT` | 任务的断言命令不在它 Path 的契约里 → 这条任务收不了口 |
| `TASK_SCOPE_OUTSIDE_PATH` | 任务 scope 超出 Path 允许的区域 |
| `TASK_REQ_UNKNOWN` / `TASK_REQ_NOT_APPROVED` | 任务挂的需求不存在 / 没批准 |
| `TASK_DEP_UNKNOWN` / `TASK_DEP_CYCLE` | 依赖指向不存在的任务 / 依赖成环 |
| `TASK_PATH_UNKNOWN` / `TASK_CONTRACT_STALE` | 挂的 Path 没了 / 记的是旧契约（领取时会自动对齐） |

第二组是为了抓住「两边都以为自己没错」的故障：Owner 在页面上看到已批准、Agent 看到未批准；
或者需求白纸黑字写了「构建也要过」，契约里却只冻结了测试命令。这类状态**没有任何异常**，
只能靠把两边摊在一起比对才看得见。

## 7. 与设计文档的对应

| 文档（docs/03 v8.8） | 代码 |
|---|---|
| §4 数据模型、ID 单调、事件日志 | `src/db.js` |
| §5 Path 契约（批准即提交、只从 git 读） | `src/contract.js`、`src/store.js::reqApprove` |
| §6 R0–R5 判定 | `src/gates.js::taskClose` |
| §7 归属判定（trailer / patch-id / 时间窗 / scope） | `src/gates.js::decorate/validOwner`、`src/git.js::trailers/patchId` |
| §8 失败计数与 parked | `src/gates.js::taskClose` finally 块 |
| §9 Owner 面（九动作） | `src/store.js` + `src/console.js` + `public/index.html` |
| 控制台随 MCP 自启（对齐 v5） | `src/console-boot.js`、`src/mcp.js::runMcp` |
| §10 Agent 面（单工具六动作） | `src/mcp.js` |
| §11 对账与导出 | `src/report.js` |

## 8. M0-lite 明确没做（不是漏，是这一版不做）

- patch-id 兜底只用于「本任务历史提交被 rebase」的识别，不做跨分支 cherry-pick 的完整归并证明。
- 新增文件必须在 `task.scope` 里**显式列出**，或由 Path 的 `allow_new_files` 放行；`allow_new_files` 目前只能在建 Path 时设定（控制台没给开关）。
- 默认不用 worktree 隔离开发，只有 R2 重跑用临时 worktree。
- 没有审批链、没有租约恢复、没有多 Owner。Owner 是单人。
- 不做账号体系：控制台没有用户名/密码/多角色。跨机器访问靠「一次性令牌」，不是靠登录；多 Owner 不支持。
- `amend` 把 Path 打回 `draft` 时，控制台只提示、不提供一键重批按钮（用 `approve` 重建）。