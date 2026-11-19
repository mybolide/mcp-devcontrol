// devcontrol — 把错误码翻成「下一步该干什么」
// 原则：只说两件事——这活儿是谁的责任（Agent 自己能做 / 只有 Owner 能做），以及具体动作。
// 错误信息本身说"哪里错了"，hint 说"然后呢"，两者不重复。
const HINTS = {
  E_NEED_APPROVED: "需求还没批准。这是人的动作（控制台「收件箱」，或终端 devcontrol approve FR-001 --path P-001），批准后你才能建任务。",
  E_NEED_RESOLUTION: "这个任务返工过。收口时补一句 --resolved-by \"这次是怎么解决的\"，让下一个人看得懂。",
  E_UNOWNED_COMMIT: "提交里没有 Task-Id trailer，内核不认。补救（不用 reset、不用重做）：给已有提交补上——git commit --amend -m \"<原标题>\" -m \"Task-Id: T-00x\" -m \"DevControl-Base: <claim 返回的 base_head>\"。往后一律用 devcontrol commit -m，它自己写这两行。",
  E_SCOPE_VIOLATION: "改到任务 scope 之外了。要么把这些文件加进 scope（Owner 可调），要么另开一个任务。",
  E_UNREGISTERED_FILES: "新增的文件不在 scope 内。把目录写进 scope，别往仓库里塞计划外的东西。",
  E_DIRTY_SCOPE: "scope 里还有没提交的改动。先 commit，再收口。",
  E_NO_EVIDENCE: "收口只核验证据，不替你跑测试。先自己跑出来：devcontrol run -- <契约里的验收命令>，然后再 devcontrol close。",
  E_EVIDENCE_STALE: "上次跑测试之后又改了文件（改文档也算），那份证据不作数。重跑一遍：devcontrol run -- <命令>。顺带一提：如果是在补项目上下文，先补完再 run，可以少跑一轮。",
  E_ASSERTION_FAILED: "验收命令没通过。看证据：devcontrol evidence run-xxxx（不给编号看最近 8 次），或控制台「证据」页。",
  E_CONTEXT_UNREVIEWED: "这次改动碰了项目上下文没覆盖的东西（新目录 / 依赖变了 / 引用的文件没了）。两条路，选一条：① 真该补——改 docs/project-context/ 那几篇，然后重跑一次 devcontrol run（改了文件，旧证据就作废了），再 close 带 contextNote；② 只是第一次碰这个目录、不值得写——直接 close 带 contextNote 说清楚。不是让你改代码。",
  E_TIMEOUT: "验收命令超时。先确认它在本机跑得完，再收口。",
  E_WIP_LIMIT: "WIP=1：你手上还有在办任务。先收了它（devcontrol close），或者 devcontrol renew 续租。",
  E_ALREADY_HELD: "这条任务已经在你手上了，不用再领。继续干活，长时间不做就 renew 续租。",
  E_CLAIMED_BY_OTHER: "任务正在别人手上。两条路：① 等租约到期（message 里写了具体时间），到期后你直接 claim 就能接；② 立刻要接就请 Owner 在控制台点「交接」——那会释放它并生成一张交接卡。",
  E_FILE_OVERLAP: "你和另一个在办任务改了同一个文件，谁后收口谁是最终版本。要真并行就换文件，或者等对方收口；Owner 也可以放行。",
  E_SCOPE_OVERLAP: "别人正在改同一片代码。换一片，或者等他收口——别硬改，冲突是这么来的。",
  E_RELEASE_OPEN: "发布里还有没完成的任务。",
  E_RELEASE_EMPTY: "发布里还没挂任务：devcontrol release plan R-001 T-001 T-002",
  E_MEMORY_CANDIDATE: "这条经验不合格，已进隔离区。按返回的模板改写成「可复用的一条」再提交。",
  E_CONTRACT: "违反契约。看 message 里的具体条款——契约是 Owner 批准的，Agent 不能改。",
  E_NO_TEST_CMD: "按项目现状采不到验收命令。这需要 Owner 处理：控制台「需求」页里给这条 Path 手填一条（例如 npm test）。",
  E_RELEASE_TAG: "发布时打不上 git tag，回滚点没建成，所以不算发布。检查 .git/refs/tags 的权限，或本地是否有同名 tag 冲突。",
  E_NO_CONTRACT: "还没有契约。先 devcontrol init，并让 Owner 批准 Path。",
  E_ILLEGAL_TRANSITION: "当前状态不允许这个动作（比如还没领任务就收口）。先看 devcontrol next 说的是哪一步。",
  E_NOT_REPO: "这里不是 git 仓库。devcontrol 靠提交链判定归属，先在仓库里用。",
  E_NO_ROOT: "找不到 .devcontrol/。在项目根目录运行，或设置 DEVCONTROL_ROOT。",
  E_USAGE: "命令写错了。devcontrol --help 看可用命令与参数；别人给的示例可以直接抄。",
  E_WEAK_NO_GIT: "弱模式没有 git 就没有提交链。改动留在工作树里，直接 devcontrol close 跑验收。",
  NOT_FOUND: "找不到你要的东西。先 devcontrol status 看清当前有什么，再挑一个真实存在的编号。",
  E_NOT_INIT: "这个目录还没有 devcontrol 项目。先 devcontrol init（想看看它怎么用就先 devcontrol help）。",
  E_NO_DELIVERY: "scope 里没有本任务的可提交改动：要么还没写，要么写到了 scope 外面（先看 devcontrol status 的 scope）。顺序是 ① 写代码 ② devcontrol run -- <契约命令> 留证据 ③ devcontrol commit ④ devcontrol close——commit 之后才有 Task-Id 归属，收口靠的就是它。",
  E_INHERITED_CHANGE:
    "这些改动在你接活之前就存在，不是这个任务干的（多半是上一任留下的）。确认要一起提交就加 --take-over；不想背这个锅就先 git stash 或让上一任提交掉。",
  E_HASH_MISMATCH: "需求内容在你看到之后被改过。刷新控制台，按最新的内容重新批准。",
  E_BUSY: "任务状态正在被另一个进程改。等一秒重试；重复出现说明有两个 Agent 在抢同一个任务。",
  E_INTERNAL: "内核内部错误。带上 devcontrol 版本和刚才的命令去开 issue；DEVCONTROL_DEBUG=1 能看到堆栈。",
  E_ABANDONED: "这条任务已经随需求一起作废了（Owner 决定这件事不做）。别再领它；要做就直接提一条新需求。",
  E_PARKED: "这条任务连续失败已 park（等 Owner 决定）。Agent 不能自己重开：Owner 在控制台「任务」里 reopen 后你再 claim，或者他会换个做法。",
  E_DEP_OPEN: "前置任务还没收口。先把它做完（devcontrol close），或者换一个不依赖它的任务。",
  E_CLAIM_STALE: "租约过期了，这个任务已经回到待领队列。重新 task.claim 一次即可（超过 45 分钟没动静就会这样）。",
  E_UNMERGED_WORK: "你的提交不在当前分支的祖先链上（被 rebase 掉了，或者提交在别的分支）。把它们合回来再收口。",
  INVALID_ARGUMENT: "参数不合法。看 message 里说的允许取值，照着改一个再重试。",
  E_NO_TASK: "手上没有在办任务。先 devcontrol task claim T-00x（devcontrol next 会告诉你该做哪个）。",
};

/** 给一个错误找一句人话建议；找不到就返回 null（别硬编） */
export function hintFor(error) {
  const code = error?.code;
  if (!code) return null;
  return HINTS[code] ?? null;
}
