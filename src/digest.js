// devcontrol — bootstrap digest：内核自己决定「下一步该做什么」，不让人挑
import { listReqs, listPaths, listTasks, getTask, now, disciplineStats } from "./store.js";
import { git, head } from "./git.js";
import { metaGet } from "./db.js";
import { releaseSummary } from "./release.js";
import { cliCommand } from "./nextcmd.js";
import { suggestScope } from "./scope.js";
import { contextStatus } from "./context.js";

/**
 * 需求覆盖度：每条需求验收有没有任务在管。
 * 这是「系统规划」的判据——缺哪条，就对 Agent 说缺哪条。
 */
export function coverage(db) {
  const reqs = listReqs(db).filter((r) => ["approved", "building"].includes(r.status));
  const tasks = listTasks(db);
  return reqs.map((r) => {
    const covered = new Set();
    for (const t of tasks) {
      if (t.requirement_id !== r.id) continue;
      // parked 也算覆盖：这条任务还挂着那条验收，只是卡在「等 Owner 决定」。
      // 早先把它当没覆盖，结果 next 让 Agent 去建一条新任务顶替它——
      // 于是同一条验收有两张单子，Owner 一 reopen 就撞车。
      for (const a of t.acceptance) if (typeof a.deriveFrom === "number") covered.add(a.deriveFrom);
    }
    const missing = r.acceptance.map((text, idx) => ({ idx, text })).filter((x) => !covered.has(x.idx));
    return { id: r.id, title: r.title, total: r.acceptance.length, covered: covered.size, missing };
  });
}

/** 依赖已满足的 backlog（内核按依赖排序，而不是按 ID 抓第一个） */
export function claimableTasks(db, tasks) {
  const backlog = tasks.filter((t) => t.status === "backlog");
  // 顺序就是优先级：Owner 可以把某条置顶（rank 更小），内核挑活时先看它。
  // 同 rank 再按 ID，保证结果稳定——不然每次 next 说的可能不是同一件事。
  const byRank = (a, b) => (a.rank ?? 0) - (b.rank ?? 0) || String(a.id).localeCompare(String(b.id));
  const ok = backlog
    .filter((t) => t.dependsOn.every((dep) => getTask(db, dep)?.status === "done"))
    .sort(byRank);
  const blocked = backlog.filter((t) => !ok.includes(t));
  return { ok, blocked };
}

/** 按当前状态下发**只该用**的动作（渐进动作面） */
export function availableActions(db) {
  const reqs = listReqs(db);
  const paths = listPaths(db);
  const tasks = listTasks(db);
  const doing = tasks.filter((t) => t.status === "doing");
  const { ok } = claimableTasks(db, tasks);
  const approvedReq = reqs.some((r) => ["approved", "building"].includes(r.status));
  // 只有「属于某条已批准需求」的 approved Path 才算有开发权限。
  // 别家需求有一条 approved Path 不算数——那正是跨需求搭便车的入口。
  const approvedPath = paths.some(
    (p) => p.status === "approved" && reqs.some((r) => ["approved", "building"].includes(r.status) && r.id === p.requirement_id),
  );
  const acts = new Set(["bootstrap", "bug.report"]);
  // Path 草案不授予权限：只要有尚在进行的需求、且当前没有 Agent 在办任务，
  // 就允许 Agent 提交新的范围提案；真正生效仍由 Owner 批准并冻结契约。
  if (!doing.length && reqs.some((r) => ["draft", "approved", "building"].includes(r.status))) {
    acts.add("path.create");
  }
  if (doing.length) {
    acts.add("task.close");
    acts.add("task.work"); // 还没写码 / 没留证据时，该做的是干活，不是收口
    acts.add("task.renew");
    acts.add("ask");
  } else if (approvedReq && approvedPath) {
    // 有可领的活就只给 claim：明明有活不干、去建一条新任务，是重复任务的源头。
    // 没有可领的活时才谈得上拆新任务。
    if (ok.length) acts.add("task.claim");
    else acts.add("task.create");
  }
  return [...acts];
}

/**
 * 在办任务进行到哪了：只看事实，不做判断。
 *
 * 为什么需要它：早先 close 之前 next 一律说「继续做完 T-00x 并收口」，
 * 而这时往往一行代码都还没写。照抄 next 必然撞 E_NO_DELIVERY——
 * 引导链把「写码 → 跑测试 → 提交」整段跳过了（黑盒实测发现）。
 * 内核知道这三件事有没有发生（提交链、证据表），就该按真相说下一步。
 */
function shipped(db, root, task) {
  try {
    const out = git(root, ["log", "--format=%H", `--grep=Task-Id: ${task.id}`, `${task.base_head || "HEAD"}..HEAD`]);
    return out.trim() ? out.trim().split("\n").length : 0;
  } catch {
    return 0; // 弱模式没有 git：没有提交这回事，交给下面的证据判断
  }
}

function hasEvidence(db, task) {
  return db.prepare("SELECT COUNT(*) c FROM runs WHERE task_id=?").get(task.id).c > 0;
}

export function bootstrap(db, root, extra = {}) {
  const reqs = listReqs(db);
  const paths = listPaths(db);
  const tasks = listTasks(db);
  const doing = tasks.filter((t) => t.status === "doing");
  const backlog = tasks.filter((t) => t.status === "backlog");
  const parked = tasks.filter((t) => t.status === "parked");
  const current = doing[0] ?? null;

  const plan = coverage(db);
  const gaps = plan.filter((p) => p.missing.length);
  const { ok: ready, blocked } = claimableTasks(db, tasks);

  // 每个 blocker 都要给出**下一步真能敲的那条命令**。
  // 只写「等 Owner 批准」的话，纯 CLI 用户拿到的是一个死胡同——
  // 评审实测里，人在这一步的唯一出路是去读源码找 POST /api/owner（T-104）。
  const draftPaths = paths.filter((p) => p.status === "draft");
  const approvedPaths = paths.filter((p) => p.status === "approved");
  const where = extra.console ? `或打开控制台 ${extra.console}` : "或起控制台：devcontrol serve";
  const blockers = [];
  for (const r of reqs.filter((r) => r.status === "draft")) {
    // 只拿这条需求自己的 Path：别的需求的 draft/approved 都不能拿来给这条需求当依据
    const p = draftPaths.find((x) => x.requirement_id === r.id) ?? approvedPaths.find((x) => x.requirement_id === r.id);
    blockers.push({
      code: "E_NEED_APPROVED",
      requirementId: r.id,
      fix: p
        ? `等人批准需求 ${r.id}：devcontrol approve ${r.id} --path ${p.id}（${where}）`
        : `需求 ${r.id} 还没有 Path——先 devcontrol init，${where}`,
    });
  }
  for (const p of draftPaths) {
    const r = reqs.find((x) => x.status === "draft") ?? null;
    blockers.push({
      code: "E_NEED_APPROVED",
      pathId: p.id,
      fix: r
        ? `等人批准 Path ${p.id}：devcontrol approve ${r.id} --path ${p.id}（${where}）`
        : `Path ${p.id} 还是草稿：先 devcontrol intake "…" --accept "…" 收一条需求，再 approve（${where}）`,
    });
  }
  for (const t of parked) blockers.push({ code: "E_PARKED", fix: `${t.id} 已 parked，等 Owner reopen` });
  for (const t of blocked) blockers.push({ code: "E_DEP_OPEN", fix: `${t.id} 等前置：${t.dependsOn.join(", ")}` });

  // 内核自己排优先级：收口 > 领取（依赖已满足）> 补拆（验收没被覆盖）> 等阻塞。
  // next.args 必须能原样执行：Agent 照抄就成功，不要逼它自己补 pathId/kind/scope。
  // Path 必须属于这条需求本身。**不许兜底到「任意已批准的 Path」**：
  // 那样 FR-004 没有 Path 时会悄悄拿到 FR-003 的 P-002，等于拿别人的授权开工。
  const approvedPath = (reqId) => paths.find((p) => p.status === "approved" && p.requirement_id === reqId);
  const next = (() => {
    if (current) {
      // 一条在办任务要按顺序走三步，next 每一步都要说对，不能一上来就催收口：
      //   ① 写代码 → ② 自己跑验收留证据 → ③ commit → ④ close
      // 「有没有提交」「有没有证据」是内核**数得出来**的事实，不是猜的。
      const weak = (metaGet(db, "mode") ?? "git") === "weak";
      const commits = weak ? 1 : shipped(db, root, current);
      const evidence = hasEvidence(db, current);
      const pathRow = paths.find((p) => p.id === current.path_id);
      const cmds = pathRow?.testCmds ?? [];
      const runCmd = cmds.length ? cmds[0] : "<契约里的验收命令>";
      const scopeText = `（只动 scope: ${(current.scope ?? []).join(", ") || "."}）`;
      if (!weak && !commits) {
        // 用 task.work 而不是 task.close：这一步没有「照抄就成功」的命令可给，
        // 硬给一条 close 等于教人撞墙（黑盒实测里，第一次照抄必然 E_NO_DELIVERY）。
        // 已经留了证据的情况单说：那时候不是「去写码」，是「去提交」。
        if (evidence) {
          return {
            action: "task.work",
            args: { id: current.id },
            why: `${current.id} 代码和证据都有了，但还没提交：提交完就能收口`,
            steps: [`devcontrol commit -m "…"`, `devcontrol close ${current.id}`],
          };
        }
        return {
          action: "task.work",
          args: { id: current.id },
          why: `${current.id} 还没提交任何代码：先写，再自己跑验收留证据，然后 commit，最后才 close`,
          steps: [
            `写代码${scopeText}`,
            `devcontrol run -- ${runCmd}`,
            `devcontrol commit -m "…"`,
            `devcontrol close ${current.id}`,
          ],
        };
      }
      if (!evidence) {
        return {
          action: "task.work",
          args: { id: current.id },
          why: `${current.id} 已经提交，但还没有验收证据：先自己跑一遍（内核不替你跑）`,
          steps: [`devcontrol run -- ${runCmd}`, `devcontrol close ${current.id}`],
          cli: cmds.length ? `devcontrol run -- ${cmds[0]}` : null,
        };
      }
      return { action: "task.close", args: { id: current.id }, why: `${current.id} 代码和证据都齐了，收口` };
    }
    if (ready[0]) return { action: "task.claim", args: { id: ready[0].id }, why: `依赖已满足，下一个可领取：${ready[0].title}` };
    if (gaps.length) {
      const gap = gaps[0];
      const pth = approvedPath(gap.id);
      if (!pth) return { action: "wait", args: {}, requirementId: gap.id, why: `需求 ${gap.id} 没有自己的已批准 Path：等 Owner 为它批准（不能借用别的需求的 Path）` };
      return {
        action: "task.create",
        args: {
          requirementId: gap.id,
          pathId: pth.id,
          kind: "feature",
          title: `覆盖验收：${gap.missing[0].text}`,
          // 不能直接把 Path 的 allowedPaths 塞进 next.args：Path 授权整个仓库时它是 `.`，
          // 照抄就会把 scope 写成整个仓库——而内核现在会拒（T-130）。
          scope: suggestScope(root, pth.allowedPaths),
          acceptance: [{ deriveFrom: gap.missing[0].idx, assertion: gap.missing[0].text }],
        },
        why: `需求 ${gap.id} 还有 ${gap.missing.length} 条验收没有任务覆盖：${gap.missing[0].text}`,
      };
    }
    if (blocked.length) return { action: "wait", args: {}, why: `${blocked[0].id} 等前置 ${blocked[0].dependsOn.join(", ")} 完成`, blocked: blocked.map((t) => t.id) };
    // 有任务被 parked（连续失败 3 次）时，能做的事已经做完了：剩下的只能等 Owner 决定
    // 「换个做法重开」还是「这件事不做了」。这时候让 Agent 去建新任务是最差的建议——
    // 那会变成两张单子管同一条验收。
    if (parked.length) {
      return {
        action: "wait",
        args: {},
        why: `${parked.map((t) => t.id).join("、")} 已 parked（连续失败），等 Owner 决定 reopen 还是放弃；不要新建任务顶替它`,
        blocked: parked.map((t) => t.id),
      };
    }
    if (!reqs.some((r) => ["approved", "building"].includes(r.status))) {
      const draft = reqs.find((r) => r.status === "draft");
      // 有草稿就别只说「等 Owner」：批准这一步在终端也能做（T-104），
      // 后面那条命令直接给出来，纯 CLI 的人照着敲就能往下走（T-112）。
      const p = draftPaths[0] ?? approvedPaths[0];
      return {
        action: "wait",
        args: {},
        why: draft
          ? p
            ? `需求 ${draft.id} 还是草稿，需要人批准（会冻结验收，Agent 改不了）：devcontrol approve ${draft.id} --path ${p.id}（${where}）`
            : `需求 ${draft.id} 还没有 Path——先 devcontrol init 建一个草稿 Path，再 approve（${where}）`
          : `还没有需求，需要人收件并批准：控制台「收件箱」，或终端 devcontrol intake "要做什么" --accept "npm test :: exit==0"`,
        ...(draft && p ? { cli: `devcontrol approve ${draft.id} --path ${p.id}` } : {}),

      };
    }
    if (!paths.some((p) => p.status === "approved")) {
      return { action: "wait", args: {}, why: `还没有已批准的 Path，等 Owner 批准（${where}）` };
    }
    // 走到这里说明：没有在办的、没有可领的、也没有没被覆盖的验收——活干完了。
    // 这时候还催「去拆新任务」是错的，Agent 会凭空造出一条没人要的工作。
    const rel = releaseSummary(db);
    if (rel?.ready) {
      return { action: "wait", args: {}, why: `需求都覆盖了。${rel.id}「${rel.title}」可以发布了：devcontrol release ship ${rel.id}` };
    }
    if (rel) {
      // 走到这里说明没有可领的活了，但发布还差任务——那些任务多半被放弃或搁置了。
      // 别让 Agent 去"补"，它补不了；这是人要决定的事。
      return {
        action: "wait",
        args: {},
        why: `需求都覆盖了。${rel.id}「${rel.title}」还有 ${rel.pending} 个任务没完成，但它们不在待办里（可能被放弃或搁置），去控制台看一下`,
      };
    }
    return { action: "wait", args: {}, why: "需求都覆盖了，没有待办任务：可以发布，或者等 Owner 提新需求" };
  })();

  const recent = db.prepare("SELECT at, action, task_id, detail FROM events ORDER BY id DESC LIMIT 3").all().map((e) => ({ at: e.at, action: e.action, taskId: e.task_id, detail: e.detail }));
  return {
    phase: current ? "executing" : backlog.length ? "planning" : "idle",
    mode: metaGet(db, "mode") ?? "git",
    actions: availableActions(db),
    release: releaseSummary(db),
    plan: gaps.length ? gaps.map((g) => ({ id: g.id, covered: `${g.covered}/${g.total}`, missing: g.missing.slice(0, 3).map((m) => m.text) })) : [],
    memories: extra.memories ?? [],
    console: extra.console ?? null,
    // MCP 连上时如果替它初始化过，必须说出来：Agent 得知道这是「刚建出来的空项目」
    // （下一步是等 Owner 批准 Path），而不是「已配好的项目」（可以直接干活）。
    autoInit: extra.autoInit ?? null,
    // 项目上下文状态：每次 bootstrap 都要报告，不能只在 init 那次说一次。
    // 否则「init 了但一直没人写」会永久沉默，而 Agent 会一直自己重新探索。
    context: (() => {
      const st = contextStatus(root);
      return {
        ready: st.ready,
        indexPath: st.indexPath,
        docs: st.docs,
        plan: st.ready ? null : ".devcontrol/context-plan.md",
        hint: st.ready
          ? null
          : `项目上下文还没写。按 .devcontrol/context-plan.md 里的模板补齐 ${st.indexPath} 和分类文档——写完 Agent 每次接任务都会自动带上，不用再自己重新读项目`,
      };
    })(),
    now: now(),
    head: (() => {
      try {
        return head(root).slice(0, 8);
      } catch {
        return null;
      }
    })(),
    requirement: (() => {
      const picked = (current && reqs.find((r) => r.id === current.requirement_id)) || reqs.filter((r) => ["approved", "building"].includes(r.status)).slice(-1)[0] || reqs[0];
      return picked ? { id: picked.id, title: picked.title, status: picked.status } : null;
    })(),
    // 显示「真正在用的那条 Path」：在办任务的、否则最近批准的一条，别再指第一条草稿
    path: (() => {
      const picked =
        (current && paths.find((p) => p.id === current.path_id)) ||
        paths.filter((p) => p.status === "approved").slice(-1)[0] ||
        paths[0];
      return picked ? { id: picked.id, status: picked.status, allowed: picked.allowedPaths } : null;
    })(),
    task: current
      ? {
          id: current.id,
          title: current.title,
          status: current.status,
          claimExpiresAt: current.claim_expires_at,
          reviewRound: current.review_round,
        }
      : null,
    blockers: blockers.slice(0, 5),
    // 同时给「照抄用的参数」（MCP）和「照抄用的命令行」（纯 CLI）：
    // 只给参数的话，CLI 用户还得自己把 requirementId 翻成 --req（T-102）。
    next: { ...next, cli: next.cli ?? cliCommand(next.action, next.args) },
    counts: {
      todo: backlog.length,
      doing: doing.length,
      parked: parked.length,
      done: tasks.filter((t) => t.status === "done").length,
      blocked: blocked.length,
    },
    // 纪律三数：被拦 / 返工 / 绕过 —— 内核到底有没有在起作用，看这三个数
    stats: disciplineStats(db),
    recent,
  };
}