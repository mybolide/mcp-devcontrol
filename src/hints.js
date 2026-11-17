// devcontrol — 把错误码翻成「下一步该干什么」
// 原则：只说两件事——这活儿是谁的责任（Agent 自己能做 / 只有 Owner 能做），以及具体动作。
// 错误信息本身说"哪里错了"，hint 说"然后呢"，两者不重复。
const HINTS = {
  E_NEED_APPROVED: "需求还没批准。这是 Owner 的动作：他在控制台「收件箱」批准后，你才能建任务。",
  E_NEED_RESOLUTION: "这个任务返工过。收口时补一句 --resolved-by \"这次是怎么解决的\"，让下一个人看得懂。",
  E_NO_DELIVERY: "scope 里还没有属于这个任务的提交。先用 devcontrol commit -m \"…\" 提交（它会自动写 Task-Id）。",
  E_UNOWNED_COMMIT: "提交里没有 Task-Id trailer，内核不认。用 devcontrol commit 而不是 git commit。",
  E_SCOPE_VIOLATION: "改到任务 scope 之外了。要么把这些文件加进 scope（Owner 可调），要么另开一个任务。",
  E_UNREGISTERED_FILES: "新增的文件不在 scope 内。把目录写进 scope，别往仓库里塞计划外的东西。",
  E_DIRTY_SCOPE: "scope 里还有没提交的改动。先 commit，再收口。",
  E_DEP_OR_TEST_TOUCH: "改了依赖或测试。这需要 Owner 放行：他在控制台「任务」里点放行并写理由（≥12 字）。Agent 不能自助。",
  E_TEST_CONFIG_TOUCH: "改了测试配置。这需要 Owner 放行：控制台「任务」里点放行。",
  E_DIFF_BUDGET: "改动量超预算。Owner 可以在控制台放行，或者把任务拆小——后者通常才是对的。",
  E_ASSERTION_FAILED: "验收命令没通过。看证据：devcontrol evidence run-xxxx（不给编号看最近 8 次），或控制台「证据」页。",
  E_TIMEOUT: "验收命令超时。先确认它在本机跑得完，再收口。",
  E_WIP_LIMIT: "WIP=1：你手上还有在办任务。先收了它（devcontrol close），或者 devcontrol renew 续租。",
  E_CLAIMED_BY_OTHER: "任务被别人领了。等他收口，或换一个任务。",
  E_SCOPE_OVERLAP: "别人正在改同一片代码。换一片，或者等他收口——别硬改，冲突是这么来的。",
  E_EVIDENCE_DRIFT: "重跑期间仓库被动了。别在收口时改文件，收完再说。",
  E_RELEASE_OPEN: "发布里还有没完成的任务。",
  E_RELEASE_EMPTY: "发布里还没挂任务：devcontrol release plan R-001 T-001 T-002",
  E_NO_CLEAN_WORKTREE: "工作树不干净，收口要在干净检出里重跑。先提交或清理。",
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
  E_NO_DELIVERY: "scope 内没有可提交的改动：要么代码还没写，要么写到了 scope 外面（先看 devcontrol status 里的 scope）。",
  E_HASH_MISMATCH: "需求内容在你看到之后被改过。刷新控制台，按最新的内容重新批准。",
  E_BUSY: "任务状态正在被另一个进程改。等一秒重试；重复出现说明有两个 Agent 在抢同一个任务。",
  E_INTERNAL: "内核内部错误。带上 devcontrol 版本和刚才的命令去开 issue；DEVCONTROL_DEBUG=1 能看到堆栈。",
  E_PARKED: "这条任务连续失败已 park（等 Owner 决定）。Agent 不能自己重开：Owner 在控制台「任务」里 reopen 后你再 claim，或者他会换个做法。",
  E_DEP_OPEN: "前置任务还没收口。先把它做完（devcontrol close），或者换一个不依赖它的任务。",
  E_CLAIM_STALE: "租约过期了，这个任务已经回到待领队列。重新 task.claim 一次即可（超过 45 分钟没动静就会这样）。",
  E_UNMERGED_WORK: "你的提交不在当前分支的祖先链上（被 rebase 掉了，或者提交在别的分支）。把它们合回来再收口。",
  E_LINT_TODO: "代码里还留着 TODO/FIXME 标记。先把它做成真实现，或者写进 issue 再删掉标记。",
  INVALID_ARGUMENT: "参数不合法。看 message 里说的允许取值，照着改一个再重试。",
  E_NO_TASK: "手上没有在办任务。先 devcontrol task claim T-00x（devcontrol next 会告诉你该做哪个）。",
};

/** 给一个错误找一句人话建议；找不到就返回 null（别硬编） */
export function hintFor(error) {
  const code = error?.code;
  if (!code) return null;
  return HINTS[code] ?? null;
}
