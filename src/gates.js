// devcontrol — claim / close 门禁（R0–R5，M0-lite）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logEvent, metaGet, metaSet, tx } from "./db.js";
import {
  DFError,
  fail,
  getPath,
  getReq,
  getTask,
  now,
  waiveFor,
  consumeWaive,
  taskExists,
  ENV_ONLY_CODES,
  FAULT_CODES,
} from "./store.js";
import { contractCommands, parseAssertion, readContract } from "./contract.js";
import { fingerprint, inScope, sha256 } from "./fingerprint.js";
import { assertScopeInsideRepo, assertScopeIsSpecific, suggestScope } from "./scope.js";
import { CONTEXT_MAX_CHARS, contextDrift, loadContext } from "./context.js";
import { addedFiles, git, head, isAncestor, logCommits, numstat, patchId, statusPorcelain, trailers } from "./git.js";
import { evaluate } from "./exec.js";
import { generalizeHint, memoryConfig, rememberTaskPitfall } from "./memory.js";
import { insertCompletion, validateCompletionInput } from "./completion.js";
import { refreshAgentFiles } from "./skill.js";
import { isVendorPath } from "./vendor.js";
// 这些失败不计入 review_round：都是「补一步就能好」，不是「试了没成功」。
// 名单只有一份，在 store.js（ENV_ONLY_CODES）——早先这里抄了一遍，两处一漏就不自洽（T-117）。

/**
 * 事件流的 actor：任务在谁手上，这条事就是谁干的。
 * 早先一律记 system，于是「多 Agent 谁做了什么」和「按人周报」全成了摆设（T-088）。
 */
const actorOf = (db, taskId) => {
  if (!taskId) return "agent";
  return db.prepare("SELECT claimed_by FROM tasks WHERE id=?").get(taskId)?.claimed_by || "agent";
};

/** 路径 a 是否覆盖路径 b；"." 表示根，覆盖一切（和 fingerprint 里的 inScope 保持一致） */
function coversPath(a, b) {
  const p = String(a).replace(/\/+$/, "").replace(/\/\*\*$/, "");
  const q = String(b).replace(/\/+$/, "").replace(/\/\*\*$/, "");
  if (p === "" || p === ".") return true;
  return q === p || q.startsWith(`${p}/`);
}

export function intersect(a, b) {
  return a.some((x) => b.some((y) => coversPath(x, y) || coversPath(y, x)));
}

/**
 * 两个 scope 是不是「同一片地」——这才该拦。
 *
 * 相交不等于冲突：所有任务都要写测试，scope 里都带 test/，
 * 但一个改 src/model、一个改 src/rating，井水不犯河水。
 * 早先只判「相交」，结果多个 Agent 根本没法同时干活——它们永远在 test/ 上打架。
 *
 * 真正的冲突是「一方完全落在另一方地盘里」：那时候谁改了什么就说不清了。
 */
export function conflicts(a, b) {
  const covers = (outer, inner) => inner.every((p) => outer.some((o) => coversPath(o, p)));
  return covers(a, b) || covers(b, a);
}

/**
 * 别的**在办**任务已经改过的文件。
 *
 * claim 时按目录粗判（conflicts），共享目录（多半是 test/）放行——那是提醒级别的。
 * 但两个 Agent 真改到同一个文件就不是"小心点"能解决的了：
 * 后提交的会把先提交的盖掉，或者留下半截，而且没人看得出来。
 *
 * 只看在办任务：别人收口之后的文件是历史，顺序修改是正常的。
 */
export function foreignFiles(db, root, taskId) {
  const others = db
    .prepare("SELECT id, base_head FROM tasks WHERE status='doing' AND id<>? AND base_head<>''")
    .all(taskId);
  const out = new Map();
  for (const o of others) {
    let list = "";
    try {
      list = git(root, ["log", "--format=", "--name-only", `${o.base_head}..HEAD`, `--grep=Task-Id: ${o.id}`]);
    } catch {
      continue;
    }
    for (const f of list.split("\n").map((x) => x.trim()).filter(Boolean)) {
      if (!out.has(f)) out.set(f, o.id);
    }
  }
  return out;
}

/** 我和谁撞了文件；返回 [{ file, task }] */
export function fileClashes(db, root, taskId, files) {
  const foreign = foreignFiles(db, root, taskId);
  return files.filter((f) => foreign.has(f)).map((f) => ({ file: f, task: foreign.get(f) }));
}

function within(scope, allowed) {
  for (const s of scope) if (!inScope(`${String(s).replace(/\/+$/, "")}/x`, allowed)) fail("E_CONTRACT", `scope ${s} 超出 allowed_paths`);
}

function contractOf(db, root, p) {
  if (!p || p.status !== "approved") fail("E_NEED_APPROVED", "Path 未批准");
  const weak = metaGet(db, "mode") === "weak";
  if (!p.contract_commit && !weak) fail("E_NEED_APPROVED", "Path 未批准（契约还没提交）");
  return readContract(root, p.contract_commit, p.id, p.hash).body;
}

function checkAcceptance(acceptance, body) {
  if (!Array.isArray(acceptance) || !acceptance.length) fail("E_CONTRACT", "缺少验收标准");
  const allowed = contractCommands(body);
  for (const item of acceptance) {
    const { command } = parseAssertion(item.assertion);
    if (!allowed.includes(command)) {
      // 光给白名单不够：多数时候这条命令是「需求里有、没有任何 Path 声明」。
      // path union=off 之后内核不再自动把它并进来，人得知道该补哪一层（Path，而不是需求）。
      fail("E_CONTRACT", `命令不在契约白名单：${command}（这条 Path 没有声明它）`, {
        allowed,
        hint: "给这个阶段新建一条包含该命令的 Path，或让 Owner 用 path adjust 补上；把 devcontrol path union 设成 off 时，内核不会再把需求验收自动并进 Path",
      });
    }
    if (typeof item.deriveFrom !== "number") fail("E_CONTRACT", "验收缺少 deriveFrom");
  }
}

// ── task.create ─────────────────────────────────────────────────────────────

export function taskCreate(db, root, input, actor = "agent") {
  return tx(db, () => {
    const req = getReq(db, input.requirementId);
    if (!req || req.status !== "approved") fail("E_NEED_APPROVED", `需求未批准：${input.requirementId}`);
    const p = getPath(db, input.pathId);
    if (!p || p.status !== "approved") fail("E_NEED_APPROVED", `Path ${input.pathId} 未批准`);
    const body = contractOf(db, root, p);
    // 没给 scope 就按 Path 折一个具体的（Path 授权整个仓库时折成顶层目录）。
    // 绝不把 Path 的上限直接当成任务的 scope——那正是「另起一套也拦不住」的根源（T-130）。
    const scope = Array.isArray(input.scope) && input.scope.length ? input.scope : suggestScope(root, p.allowedPaths);
    if (!scope.length) {
      fail("E_CONTRACT", "没法给任务定 scope：仓库里没有可指定的目录", {
        hint: "用 --scope 明确列出这次要动的文件或目录，比如 --scope src/index.js",
      });
    }
    assertScopeInsideRepo(scope);
    // scope 是整个仓库 = 没有 scope。这一步必须在 within() 之前：否则 Agent 会先被
    // 「超出 Path 允许范围」教育一遍，再回来把 scope 写成 `.` 绕过去（T-130）。
    assertScopeIsSpecific(scope);
    within(scope, body.allowedPaths);
    const acceptance = (input.acceptance ?? []).map((a) =>
      typeof a === "string" ? { deriveFrom: 0, assertion: a } : { deriveFrom: a.deriveFrom ?? 0, assertion: a.assertion },
    );
    checkAcceptance(acceptance, body);
    const dependsOn = Array.isArray(input.dependsOn) ? input.dependsOn.map(String) : [];
    for (const dep of dependsOn) if (!taskExists(db, dep)) fail("E_CONTRACT", `依赖不存在：${dep}`);
    const title = String(input.title ?? "").trim();
    if (!title) fail("E_CONTRACT", "标题不能为空");
    // 计数器可能落后（早期手工插库），撞号就往下找空号，不要用裸 SQLite 错误崩掉
    const usedT = new Set(db.prepare("SELECT id FROM tasks").all().map((r) => Number(String(r.id).replace(/\D/g, "")) || 0));
    let n = Number(metaGet(db, "counter:T") ?? 0);
    do {
      n += 1;
    } while (usedT.has(n));
    // 类型：常用别名归一，未知值明确报错——静默改写成 feature 会让人以为分类生效了
    const KINDS = ["feature", "bugfix", "chore", "test"];
    const KIND_ALIASES = { fix: "bugfix", feat: "feature", bug: "bugfix", refactor: "chore", docs: "chore", ci: "chore", build: "chore", perf: "chore" };
    const rawKind = String(input.kind ?? "feature").trim().toLowerCase();
    const kind = KINDS.includes(rawKind) ? rawKind : KIND_ALIASES[rawKind];
    if (!kind) fail("INVALID_ARGUMENT", `未知任务类型 ${rawKind}，可用 ${KINDS.join(" / ")}（fix→bugfix、feat→feature、refactor/docs/ci→chore）`);
    // 交付模式：code 交出归属提交；verify 只交出「跑通验收」的证据。
    // 它必须独立于 kind：kind 只是分类，把门禁挂在分类上等于让标签替代事实（T-014 的老坑）。
    const DELIVERIES = ["code", "verify"];
    const DELIVERY_ALIASES = { evidence: "verify", "evidence-only": "verify", "verify-only": "verify" };
    const rawDelivery = String(input.delivery ?? "code").trim().toLowerCase();
    const delivery = DELIVERIES.includes(rawDelivery) ? rawDelivery : DELIVERY_ALIASES[rawDelivery];
    if (!delivery) {
      fail("INVALID_ARGUMENT", `未知交付模式 ${rawDelivery}，可用 ${DELIVERIES.join(" / ")}（code=交出提交，verify=只跑验收、不交代码）`);
    }
    const id = `T-${String(n).padStart(3, "0")}`;
    db.prepare(
      "INSERT INTO tasks(id,requirement_id,path_id,kind,delivery,title,status,scope_json,acceptance_json,depends_on_json,budget_lines,base_head,contract_hash,contract_commit,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      req.id,
      p.id,
      kind,
      delivery,
      title,
      "backlog",
      JSON.stringify(scope),
      JSON.stringify(acceptance),
      JSON.stringify(dependsOn),
      // 预算默认跟 Path 契约走，不写死：早先这里硬编码 400，而 init 给 Path 写的是 1200、
      // Owner 调过的可能是 12000。于是 claim 下发的规范说「不超过 12000 行」，
      // 同一个响应里的 budgetLines 却是 400——Agent 照大的写，收口被内核自己数落（T-101）。
      Number(input.budgetLines ?? body.budgetLines ?? p.budget_lines ?? 1200),
      p.contract_commit ?? "",
      p.hash,
      p.contract_commit ?? "",
      now(),
      now(),
    );
    db.prepare("INSERT INTO meta(key,value) VALUES('counter:T',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
    logEvent(db, { actor, action: "task.create", taskId: id, detail: title });
    return getTask(db, id);
  });
}

/**
 * 旧版 next 自动生成的「覆盖验收」任务曾统一按 code 创建。
 * 只有在证据已经完整证明它其实是纯验证任务时，claim 才做一次自动迁移：
 *   - 任务必须匹配旧生成器的特征（feature +「覆盖验收：」+ deriveFrom 原样引用）；
 *   - 每条冻结验收都已有当前 HEAD、当前 scope 指纹上的通过证据；
 *   - 工作树干净，且任务名下没有任何提交/patch。
 *
 * 缺任一条件都保持 code，不猜、不放宽门禁。迁移写 system 审计事件，且只在 claim
 * 成功后发生，避免把普通实现任务或尚未验证的任务静默改成交付证据。
 */
function migrateLegacyCoverageTaskToVerify(db, root, task, currentHead) {
  if (
    !currentHead ||
    task.delivery !== "code" ||
    task.kind !== "feature" ||
    !task.title.startsWith("覆盖验收：") ||
    !task.acceptance.length
  ) return null;

  const req = getReq(db, task.requirement_id);
  if (!req || task.acceptance.some((item) => {
    if (!Number.isInteger(item.deriveFrom) || item.deriveFrom < 0) return true;
    const source = req.acceptance[item.deriveFrom];
    const sourceAssertion = typeof source === "string" ? source : source?.assertion;
    return sourceAssertion !== item.assertion;
  })) return null;

  try {
    const owned = git(root, ["log", "--format=%H", `--grep=Task-Id: ${task.id}`, "HEAD"])
      .split("\n").map((x) => x.trim()).filter(Boolean);
    if (owned.length || db.prepare("SELECT 1 FROM patch_ids WHERE task_id=? LIMIT 1").get(task.id)) return null;

    const dirty = statusPorcelain(root, ["--untracked-files=all"])
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
      .filter((file) => file && !file.startsWith(".devcontrol/") && !isVendorPath(file, root));
    if (dirty.length) return null;

    const currentFingerprint = fingerprint(root, task.scope, null);
    for (const item of task.acceptance) {
      const { command, predicate } = parseAssertion(item.assertion);
      const run = db.prepare(
        "SELECT exit_code, head, fingerprint, output FROM runs WHERE task_id=? AND command=? ORDER BY started_at DESC LIMIT 1",
      ).get(task.id, command);
      if (
        !run ||
        run.exit_code !== 0 ||
        run.head !== currentHead ||
        run.fingerprint !== currentFingerprint ||
        !evaluate(predicate, { exit: run.exit_code, stdout: run.output })
      ) return null;
    }

    const updated = db.prepare("UPDATE tasks SET delivery='verify', updated_at=? WHERE id=? AND delivery='code'").run(now(), task.id);
    if (updated.changes !== 1) return null;
    const reason = "legacy coverage task auto-migrated: all frozen assertions passed on current HEAD; clean worktree; no task-owned commits";
    logEvent(db, { actor: "system", action: "task.delivery.auto-migrate", taskId: task.id, detail: reason });
    return { from: "code", to: "verify", reason };
  } catch {
    // 自动迁移失败时按原交付模式继续；绝不因迁移探测故障放宽或阻断正常 claim。
    return null;
  }
}

// ── task.claim ─────────────────────────────────────────────────────────────

export function taskClaim(db, root, input, actor = "agent") {
  return tx(db, () => {
    const t = getTask(db, input.id);
    if (!t) fail("NOT_FOUND", `任务不存在：${input.id}`);
    if (t.status === "done") fail("E_ILLEGAL_TRANSITION", `${t.id} 已完成`);
    // 终态要各说各的：abandoned 是「需求作废连带放弃」，不是「有人占着」。
    // 走到 CAS 的兜底会被报成「由他人持有」——那条消息既错又荒谬（根本没人持有）。
    if (t.status === "abandoned") {
      fail("E_ABANDONED", `${t.id} 已随需求作废，不能再领`, { taskId: t.id, status: t.status });
    }
    const req = getReq(db, t.requirement_id);
    if (!req || ["draft", "parked"].includes(req.status)) fail("E_NEED_APPROVED", `需求状态 ${req?.status}`);
    const p = getPath(db, t.path_id);
    const body = contractOf(db, root, p);
    within(t.scope, body.allowedPaths);
    checkAcceptance(t.acceptance, body);
    for (const dep of t.dependsOn) {
      const d = getTask(db, dep);
      if (!d || d.status !== "done") fail("E_DEP_OPEN", `前置 ${dep} 未完成`, { dep, status: d?.status ?? "missing" });
    }
    // WIP 先查：手上有活是最根本的原因。先报 scope 冲突会把人引到错的方向——
    // 他换个 scope 再来，照样被 WIP 挡住。
    const mine = db.prepare("SELECT id FROM tasks WHERE status='doing' AND claimed_by=? AND id<>?").all(actor, t.id);
    if (mine.length) fail("E_WIP_LIMIT", `你手上还有 ${mine[0].id}`, { holding: mine[0].id });
    // 注意：这里必须传 t.id，否则 id<>NULL 恒不成立，相交检查会形同虚设（并发探针发现的）
    const doing = db
      .prepare("SELECT id, scope_json FROM tasks WHERE status='doing' AND id<>? AND closing_token IS NULL")
      .all(t.id)
      .map((r) => ({ id: r.id, scope: JSON.parse(r.scope_json) }));
    const shared = [];
    for (const other of doing) {
      if (conflicts(t.scope, other.scope)) {
        fail("E_SCOPE_OVERLAP", `与在办任务 ${other.id} 抢同一片地`, { conflict: other.id, scope: other.scope });
      }
      // 相交但不冲突：共享目录（多半是 test/）。不拦，但要告诉 Agent 别改同一个文件。
      const overlap = t.scope.filter((p) => intersect([p], other.scope));
      if (overlap.length) shared.push({ task: other.id, paths: overlap });
    }
    for (const row of db.prepare("SELECT id FROM tasks WHERE status='doing' AND closing_token IS NULL AND claim_expires_at < ?").all(now())) {
      db.prepare("UPDATE tasks SET status='backlog', claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL WHERE id=?").run(row.id);
    }
    let anchor = null;
    try {
      anchor = head(root);
    } catch {
      anchor = null; // 弱模式
    }
    const fp = fingerprint(root, t.scope, anchor);
    const exp = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
    // parked 必须由 Owner reopen，Agent 不能自己重开：连续失败 3 次是「需要人看一眼」的信号，
    // 让它自己领回去重试第 4 次，等于把这套门禁当摆设。
    if (t.status === "parked") {
      // 挂起不该是死路：代码/证据类失败，Agent 自己 task.rework 就能回去重试；
      // 授权类才需要人。措辞必须和 reworkState 的判据一致，否则又是一封「让人干等」的信。
      fail("E_PARKED", `${t.id} 已 parked（连续失败 3 次）：先用 task.rework 看是谁的问题——代码/证据类会放你回去重试，授权类会明确告诉你等 Owner`, {
        taskId: t.id,
        hint: `devcontrol task rework ${t.id}`,
      });
    }
    // 重领时 base_head 不能往后挪。Owner 调预算 / 重新批准会在任务自己的提交**之后**
    // 产生一个新的契约提交；直接拿最新契约提交当起点，就把任务已有的提交甩出了区间，
    // 变成「区间内没有本任务的提交」——明明代码早就写完了。
    let baseHead = p.contract_commit ?? "";
    if (t.base_head && baseHead) {
      try {
        if (isAncestor(root, t.base_head, baseHead)) baseHead = t.base_head;
      } catch {
        /* 弱模式或历史异常：保持当前契约提交 */
      }
    }
    const res = db
      .prepare(
        "UPDATE tasks SET status='doing', claimed_by=?, claimed_at=?, claim_expires_at=?, claim_fingerprint=?, contract_hash=?, contract_commit=?, base_head=?, updated_at=? WHERE id=? AND status='backlog' AND (claimed_by IS NULL OR claim_expires_at < ?)",
      )
      .run(actor, now(), exp, fp, p.hash, p.contract_commit ?? "", baseHead, now(), t.id, now());
    if (res.changes !== 1) {
      const cur = getTask(db, t.id);
      if (!cur?.claimed_by) {
        // 没有具体的人持有它：真实原因只能是「状态不对」，不要编一个持有者出来
        fail("E_ILLEGAL_TRANSITION", `${t.id} 当前 ${cur?.status ?? "?"}，不是可领取状态`, { taskId: t.id, status: cur?.status ?? null });
      }
      if (cur.claimed_by === actor) {
        // 自己已经拿着它了：说「别人持有」会让人去找一个不存在的人
        fail("E_ALREADY_HELD", `${t.id} 已经在你手上（租约到 ${cur.claim_expires_at ?? "?"}）`, { taskId: t.id });
      }
      fail("E_CLAIMED_BY_OTHER", `${t.id} 由 ${cur.claimed_by} 持有（租约到 ${cur.claim_expires_at ?? "?"}）`, {
        holder: cur.claimed_by,
        expiresAt: cur.claim_expires_at ?? null,
      });
    }
    logEvent(db, { actor, action: "task.claim", taskId: t.id, detail: actor });
    const deliveryMigration = migrateLegacyCoverageTaskToVerify(db, root, t, anchor);
    if (deliveryMigration) t.delivery = "verify";
    // 项目上下文在 claim 这一刻读一次，随返回一起下发（见下面 return 里的 context）。
    const ctxLoaded = loadContext(root);
    // 接活那一刻工作区里已经有的改动，不是这个任务干的（多半是上一任留下的）。
    // 记下来，commit 时才分得清「我写的」和「我继承的」——否则接手的人把前任的活
    // 一起提交，盖上自己的 Task-Id，归属就说不清了（T-095）。
    try {
      // 必须带 --untracked-files=all：上一任留下的半成品多半是新建文件，
      // 只用 --untracked-files=no 会看不见它们，快照就成了摆设。
      const dirtyNow = statusPorcelain(root, ["--untracked-files=all"])
        .split("\n")
        .filter((line) => line.length > 3)
        .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
        .filter((f) => f && !f.startsWith(".devcontrol/") && !isVendorPath(f, root));
      metaSet(db, `dirty-at-claim:${t.id}`, JSON.stringify(dirtyNow));
    } catch {
      // 弱模式没有 git：没有继承的概念
    }
    const verifyCommands = [...new Set((t.acceptance ?? []).map((item) => parseAssertion(item.assertion).command).filter(Boolean))];
    if (!verifyCommands.length) verifyCommands.push(contractCommands(body)[0] ?? "<契约验收命令>");
    return {
      id: t.id,
      title: t.title,
      scope: t.scope,
      acceptance: t.acceptance,
      dependsOn: t.dependsOn,
      // 交付模式必须跟着 claim 一起下发：verify 任务没有 commit 这一步，
      // 照抄 code 的四步会在 commit 上空转（T-011）。
      delivery: t.delivery ?? "code",
      deliveryMigration,
      cadence:
        t.delivery === "verify"
          ? [...verifyCommands.map((command) => `devcontrol run -- ${command}`), `devcontrol close ${t.id}（verify 不用 commit）`]
          : [`devcontrol run -- ${contractCommands(body)[0] ?? "<契约验收命令>"}`, 'devcontrol commit -m "…"', `devcontrol close ${t.id}`],
      // Agent 开工时就该知道「代码要怎么写」，而不是收口被拦才第一次听说
      standards: body.standards ?? [],
      // 和别的在办任务共享的目录：不冲突，但这些地方别同时改
      shared,
      contractHash: p.hash,
      contractCommit: p.contract_commit,
      baseHead: p.contract_commit ?? "",
      budgetLines: t.budget_lines,
      claimExpiresAt: exp,
      testCmds: contractCommands(body),
      // 项目上下文：init 时 Agent 写好的「这个项目怎么回事」，这里**直接把内容塞进来**。
      // 只给路径的话，Agent 会不会去读是运气；给内容才是真的省掉它重新探索的时间。
      // 没写就明说没写——静默省略等于让它以为这项目没有约定。
      context: ctxLoaded ? ctxLoaded.text : null,
      contextHint: ctxLoaded
        ? ctxLoaded.truncated
          ? `项目上下文共 ${ctxLoaded.docs} 篇，超过 ${CONTEXT_MAX_CHARS} 字符的部分没随任务下发：改到那部分模块时先读 docs/project-context/ 下对应文件`
          : null
        : `项目还没有上下文文档（docs/project-context.md）。写之前先读一遍项目，或让 Owner 跑 devcontrol init 看该写哪几篇`,
      contextChars: ctxLoaded ? ctxLoaded.chars : 0,
    };
  });
}

// ── task.renew：续租（契约 §5.1，TTL 45 分钟） ──────────────────────────────

const CLAIM_TTL_MS = 45 * 60_000;

export function taskRenew(db, root, input, actor = "agent") {
  return tx(db, () => {
    const t = getTask(db, input.id);
    if (!t) fail("NOT_FOUND", `任务不存在：${input.id}`);
    if (t.status !== "doing") fail("E_CLAIM_STALE", `${t.id} 当前 ${t.status}，不在办，需重新 claim`);
    if (t.claimed_by !== actor) fail("E_CLAIMED_BY_OTHER", `${t.id} 由 ${t.claimed_by} 持有`);
    if (!t.claim_expires_at || t.claim_expires_at < now()) fail("E_CLAIM_STALE", `${t.id} 租期已过，需重新 claim`);
    const exp = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
    // CAS 打在旧 exp 上：与惰性回收/他人续租并发时不覆盖
    const res = db
      .prepare("UPDATE tasks SET claim_expires_at=?, updated_at=? WHERE id=? AND status='doing' AND claimed_by=? AND claim_expires_at=?")
      .run(exp, now(), t.id, actor, t.claim_expires_at);
    if (res.changes !== 1) fail("E_CLAIM_STALE", `${t.id} 租期状态已变化，需重新 claim`);
    logEvent(db, { actor, action: "task.renew", taskId: t.id, detail: actor });
    return { ok: true, id: t.id, claimExpiresAt: exp };
  });
}

// ── task.close：R0 → R1 → R2 → R3 → R4 → 收口 ─────────────────────────────

function isApprove(c) {
  return (
    /^chore\(devcontrol\): (approve|amend) /.test(c.subject ?? "") &&
    c.authorEmail === "devcontrol@localhost" &&
    c.files.length > 0 &&
    c.files.every((f) => f.startsWith(".devcontrol/contracts/"))
  );
}

// 内核自己造的提交（approve / amend / init）：不参与归属判定，永远不算无主。
// init 会在任务进行中提交配置文件，按普通提交判会被判「无主」并把收口堵死；
// 但它只认内核托管的那些文件，防止有人用这个提交信息夹带别的改动。
const INIT_MANAGED = [".gitignore", ".gitattributes", "AGENTS.md", "CLAUDE.md", ".mcp.json", ".cursor/", "opencode.json", ".agents/", ".devcontrol/contracts/"];
function isKernelCommit(c) {
  if (c.authorEmail !== "devcontrol@localhost") return false;
  const subject = c.subject ?? "";
  if (/^chore\(devcontrol\): (approve|amend)\b/.test(subject)) return true;
  // init 与「同步 Agent 说明」都是内核自己动托管文件产生的提交，不属于任何任务；
  // 不认它们的话，下一个任务收口时会把它们当成无主提交拦死（T-146 踩过）。
  // 边界照样卡住：只认托管文件，动了别的一律不算。
  const managed = /^chore\(devcontrol\): (init|同步 Agent 说明)$/.test(subject);
  return managed && c.files.length > 0 && c.files.every((f) => INIT_MANAGED.some((p) => f === p || f.startsWith(p)));
}
function decorate(root, commits) {
  return commits.map((c) => ({
    ...c,
    files: numstat(root, c.sha).map((n) => n.file),
    trailer: trailers(c.body, "Task-Id")[0] ?? null,
    patch: patchId(root, c.sha),
  }));
}

function isTestConfig(f) {
  return /(^|\/)(vitest\.config\.[^/]+|jest\.config\.[^/]+|conftest\.py|\.npmrc|pnpm-workspace\.yaml|tsconfig[^/]*\.json)$/.test(f);
}
function isTestPath(f) {
  return /(^|\/)(__tests__|tests?|spec)\//.test(f) || /\.(test|spec)\.[^/]+$/.test(f);
}
function isPkg(f) {
  return /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f);
}

/**
 * 记录一条测试证据。**由 Agent 触发**（`devcontrol run -- <cmd>`），内核只负责存与核验。
 *
 * 指纹存的是「内容指纹」（anchor 传 null）：commit 不改变文件内容，所以
 * 「先跑测试、再提交、再收口」这个最常见的顺序不会被误判成过期；
 * 而「跑完之后又改了代码」一定会改变指纹，证据立刻失效。
 */
export function recordEvidence(db, root, { taskId, command, result, scope = ["."] }) {
  const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const fp = fingerprint(root, scope, null);
  let h = "";
  try {
    h = head(root);
  } catch {
    h = ""; // 弱模式
  }
  const id = `run-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO runs(id,task_id,assertion_idx,command,exit_code,head,fingerprint,log_sha256,output,started_at,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, taskId, -1, command, result.exit, h, fp, sha256(out), out.slice(0, 20000), now(), result.durationMs ?? 0);
  logEvent(db, { actor: actorOf(db, taskId), action: "run.evidence", taskId, detail: `${command} → exit ${result.exit}` });
  return { id, fingerprint: fp, exit: result.exit, command };
}

export async function taskClose(db, root, input, opts = {}) {
  // 收口要核对证据指纹和提交链，大仓库上也要一两秒；中途没有任何输出会让人以为卡死了。
  // 进度只走回调：CLI 打到 stderr（stdout 必须保持干净 JSON），MCP 不传就没有噪音。
  const progress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const startedAt = Date.now();
  const mark = (stage, detail) => {
    try {
      progress({ stage, detail, elapsedMs: Date.now() - startedAt });
    } catch {
      /* 进度上报失败不能影响收口本身 */
    }
  };
  const t0 = getTask(db, input.id);
  if (!t0) fail("NOT_FOUND", `任务不存在：${input.id}`);
  if (t0.status !== "doing") fail("E_ILLEGAL_TRANSITION", `${t0.id} 当前 ${t0.status}`);
  if (Date.parse(t0.claim_expires_at ?? 0) < Date.now()) fail("E_CLAIM_STALE", "claim 已过期，先 task.claim 续期");

  // 失败过的任务：必须交出「最后怎么解决的」，这是坑库的唯一入口（不靠 Agent 自觉）
  const rounds = t0.review_round ?? 0;
  const resolvedBy = String(input.resolvedBy ?? "").trim();
  if (rounds > 0 && memoryConfig(process.env, root).enabled && !resolvedBy) {
    fail("E_NEED_RESOLUTION", `${t0.id} 已经失败 ${rounds} 次，close 必须带 resolvedBy（一句话：最后怎么解决的）`, {
      reviewRound: rounds,
      hint: 'action=task.close, resolvedBy: "把 X 改成 Y 就好了"',
    });
  }

  const token = crypto.randomUUID();
  const cas = db
    .prepare("UPDATE tasks SET closing_at=?, closing_token=? WHERE id=? AND status='doing' AND (closing_token IS NULL OR closing_at < ?)")
    .run(now(), token, t0.id, new Date(Date.now() - 60 * 60_000).toISOString());
  if (cas.changes !== 1) fail("E_BUSY", "另一个 close 正在进行");

  let last = null;
  mark("start", `开始收口 ${t0.id}（核对 Agent 提交的验收证据）`);
  try {
    const t = getTask(db, t0.id);
    const p = getPath(db, t.path_id);
    const body = readContract(root, t.contract_commit, p.id, t.contract_hash).body;
    // scope 可能在 doing 期间被 adjust 改过：收口前必须重新对照契约
    within(t.scope, body.allowedPaths);
    // 弱模式（无 git）：没有 base_head，跳过提交归属与 diff 统计，只跑验收 + 指纹
    const weak = !t.base_head;
    const head0 = weak ? null : head(root);
    // 交付模式：verify 不需要归属提交（它就是「只跑验收」），但反过来严禁提交。
    const verify = t.delivery === "verify";
    let files = [];
    let lines = 0;
    let owned = [];
    // 规范观测：内核只报事实，不判违规（弱模式也要有，所以放在 if (!weak) 外面）
    const observations = [];
    // verify 交付：不要求归属提交（这正是它存在的理由），但反过来严禁提交。
    // 否则「声明 verify」就成了绕开归属、scope、diff 预算三条检查的后门——
    // 那比原来的缺口更糟。所以这里查的不是「有没有交付」，是「有没有偷偷交了产品代码」。
    if (!weak && verify) {
      const mine = git(root, ["log", "--format=%H", `--grep=Task-Id: ${t.id}`, "HEAD"])
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      if (mine.length) {
        fail("E_VERIFY_COMMITTED", `${t.id} 的交付模式是 verify（只跑验收、不交代码），但它名下有 ${mine.length} 个提交`, {
          commits: mine,
          hint: `要么让真正的工作任务交付这份代码、这里改成 code 交付；要么撤掉提交。verify 收口只要两步：devcontrol run -- <契约命令>，然后 devcontrol close ${t.id}`,
        });
      }
    }
    if (!weak && !verify) {

    // R0
    // 区间起点要兜一层：Owner 调预算/重批会在任务提交之后产生新的契约提交，
    // base_head 一旦被推到任务自己的提交之后，「本任务的提交」就凭空消失了。
    // 所以再往前找一次：本任务最早那条带 Task-Id 的提交的父提交。
    let rangeBase = t.base_head;
    try {
      const firstMine = git(root, ["log", "--reverse", "--format=%H", `--grep=Task-Id: ${t.id}`, "HEAD"])
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)[0];
      if (firstMine) {
        const parent = git(root, ["rev-parse", `${firstMine}^`]).trim();
        if (parent && isAncestor(root, parent, rangeBase)) rangeBase = parent;
      }
    } catch {
      /* 取不到就用原来的起点 */
    }
    const commits = decorate(root, logCommits(root, `${rangeBase}..HEAD`));
    owned = commits.filter((c) => c.trailer === t.id || (!isApprove(c) && c.patch && db.prepare("SELECT 1 FROM patch_ids WHERE patch_id=? AND task_id=?").get(c.patch, t.id)));
    // git 的时间只到秒，claim/closed 是毫秒：统一按秒比较，否则同一秒内的提交会被判成无主
    const secFloor = (iso) => {
      const t = Date.parse(iso ?? 0);
      return Number.isFinite(t) ? Math.floor(t / 1000) * 1000 : 0;
    };
    const validOwner = (c) => {
      if (!c.trailer || !taskExists(db, c.trailer)) return false;
      const o = getTask(db, c.trailer);
      // 已收口的任务只认它 close 时登记过的提交，防止事后用 --date 把越权提交"过继"给已完成任务。
      // force-close 是 Owner 越过门禁接管，不走 close 的登记流程；若仍按 patch_ids 判定，
      // 它的提交就会把区间内之后所有任务的收口堵死（表现为"无主提交"）。这里退回时间窗+作者+scope。
      if (o.status === "done" && o.closed_by !== "force-close") {
        return Boolean(c.patch && db.prepare("SELECT 1 FROM patch_ids WHERE patch_id=? AND task_id=?").get(c.patch, o.id));
      }
      const at = Date.parse(c.authorTime);
      // 只卡上界：契约 §5.3 写的是「早于 claimed_at 不判违规」——过期重领、挂起再回来后
      // claimed_at 会被重置，早先的提交仍属本任务。挂起后 to 为空，退回「现在」。
      const to = secFloor(o.closed_at ?? o.claim_expires_at ?? Date.now()) + 999;
      if (!(at <= to)) return false;
      // 作者必须是曾经领过这个任务的人。挂起/重领会清空 claimed_by，所以同时查事件里的领取记录。
      const actors = new Set(
        db
          .prepare("SELECT detail AS v FROM events WHERE task_id=? AND action IN ('task.claim','task.renew')")
          .all(o.id)
          .map((r) => String(r.v ?? "")),
      );
      if (o.claimed_by) actors.add(o.claimed_by);
      return actors.has(c.authorEmail) && c.files.every((f) => inScope(f, o.scope));
    };
    // 伪造的 approve 提交（身份/前缀/路径都对，但内核从没写过这个 sha）按无主处理。
    // 合法判据三选一：
    //   ① sha 就是某条 Path 记下的 contract_commit；
    //   ② sha 出现在内核自己记的 req.approve 事件里（同一条 Path 被重新批准后，
    //      paths 表里的 sha/hash 会被新契约覆盖，只有事件日志还留着历史）；
    //   ③ 该提交里的契约文件内容哈希等于某条 Path 记下的 hash。
    const knownBySha = new Set(
      db.prepare("SELECT contract_commit AS v FROM paths WHERE contract_commit IS NOT NULL AND contract_commit<>''").all().map((r) => r.v),
    );
    const knownByHash = new Set(db.prepare("SELECT hash AS v FROM paths WHERE hash IS NOT NULL AND hash<>''").all().map((r) => r.v));
    const knownApproveShas = db
      .prepare("SELECT detail FROM events WHERE action='req.approve'")
      .all()
      .map((r) => String(r.detail ?? "").match(/@\s*([0-9a-f]{7,40})/i)?.[1])
      .filter(Boolean);
    const fakeApprove = (c) => {
      if (!isApprove(c)) return false;
      if (knownBySha.has(c.sha)) return false;
      if (knownApproveShas.some((s) => c.sha.startsWith(s))) return false;
      return !c.files
        .filter((f) => f.startsWith(".devcontrol/contracts/"))
        .some((f) => {
          try {
            return knownByHash.has(sha256(Buffer.from(git(root, ["show", `${c.sha}:${f}`]))));
          } catch {
            return false;
          }
        });
    };
    // 伪造的 approve 提交（身份/前缀/路径都对，但内核从没写过这个 sha）按无主处理
    const unowned = commits.filter((c) => (!isKernelCommit(c) || fakeApprove(c)) && !owned.includes(c) && !validOwner(c));
    if (unowned.length) fail("E_UNOWNED_COMMIT", `${unowned.length} 个无主提交`, { commits: unowned.map((c) => c.sha) });
    if (!owned.length) {
      // 别再在这里补一句半截 hint：它会被当成"更具体的提示"盖掉 hints.js 里的完整说明，
      // 结果人只看到"devcontrol commit -m ..."，反而先 commit 再补测试（T-111）。
      fail("E_NO_DELIVERY", "区间内没有本任务的提交");
    }

    // 契约完整性
    if (readContract(root, t.contract_commit, p.id).hash !== t.contract_hash) fail("E_CONTRACT", "契约哈希不符");
    const contractEdits = owned.filter((c) => c.files.some((f) => f.startsWith(".devcontrol/contracts/")) && !isApprove(c));
    if (contractEdits.length) fail("E_CONTRACT", "任务提交改动了契约文件");

    // R1
    files = [...new Set(owned.flatMap((c) => c.files))];
    const outOfScope = files.filter((f) => !inScope(f, t.scope));
    if (outOfScope.length) fail("E_SCOPE_VIOLATION", "改动超出任务 scope", { files: outOfScope });
    // 新增文件只要落在任务 scope 内就放行：scope 写成目录（如 test）时，新增 test/x.test.js 属于正常动作。
    // 不在 scope 里的新增文件仍要拦（防止往仓库里塞别的东西）。
    const unregistered = owned
      .flatMap((c) => addedFiles(root, c.sha))
      .filter((f) => !inScope(f, t.scope) && !(body.allowNewFiles && inScope(f, body.allowedPaths)));
    if (unregistered.length) {
      fail("E_UNREGISTERED_FILES", `新增文件不在任务 scope 内：${unregistered.join("、")}`, { files: unregistered });
    }
    lines = owned.reduce((n, c) => n + numstat(root, c.sha).reduce((m, x) => m + x.added + x.deleted, 0), 0);
    const pathUsed = db.prepare("SELECT changed_lines FROM tasks WHERE path_id=? AND status='done'").all(p.id).reduce((n, r) => n + r.changed_lines, 0);
    // 预算不是安全边界（安全边界是 scope 和验收），只是"任务是不是太大了"的提醒：
    // 所以取「领取时 pin 的」与「当前 Path 契约」的较大者——Owner 放宽预算立即生效，
    // 收紧则只影响之后领取的任务，不会把人卡在半路。
    // 文件级撞车：目录相交可以共用（test/），真改到同一个文件就会互相覆盖
    const clash = fileClashes(db, root, t.id, files);
    if (clash.length) {
      const who = [...new Set(clash.map((c) => c.task))].join("、");
      fail("E_FILE_OVERLAP", `和 ${who} 改了同一个文件：${clash.slice(0, 3).map((c) => c.file).join("、")}`, {
        files: clash.map((c) => c.file),
        tasks: [...new Set(clash.map((c) => c.task))],
      });
    }

    // ── 规范：内核把事实摆出来，但不判违规 ───────────────────────────────────
    //
    // 预算、标记残留、测试配置、依赖与既有测试——这四条都是「代码写得好不好」，
    // 判断题留给 Owner（控制台上看得到）。内核只负责数清楚、记下来。
    // 唯一继续拦的是 scope：那不是质量，是「这行代码属于哪个任务」的事实问题，
    // 内核不判它就没人能判，归属链会断。
    const curBudget = Number(readContract(root, p.contract_commit, p.id).body?.budgetLines ?? 0);
    const pathBudget = Math.max(Number(body.budgetLines ?? 1200), curBudget);
    if (pathUsed + lines > pathBudget) {
      observations.push({ id: "budget", detail: `Path 累计 ${pathUsed + lines} 行 > 预算 ${pathBudget}`, used: pathUsed + lines, budget: pathBudget });
    }
    if (lines > t.budget_lines) {
      observations.push({ id: "budget", detail: `本任务改了 ${lines} 行 > 预算 ${t.budget_lines}`, used: lines, budget: t.budget_lines });
    }
    // 只认「注释开头的标记」：斜杠注释、井号注释、块注释、HTML 注释后面紧跟标记词。
    // 只看词根会把「提到这个词」也算成「留下标记」，连内核自己的文案都会被误伤。
    const MARK = /(?:\/\/|#|\/\*|\*|<!--)\s*(TODO|FIXME|HACK|XXX)\b/;
    const todos = owned
      .flatMap((c) => git(root, ["diff", "-m", "--first-parent", `${c.sha}^..${c.sha}`]).split("\n"))
      .filter((l) => /^\+/.test(l) && MARK.test(l));
    if (todos.length) {
      observations.push({ id: "todo", detail: `留下 ${todos.length} 处 TODO/FIXME 标记`, samples: todos.slice(0, 3).map((x) => x.trim().slice(0, 80)) });
    }
    const cfg = files.filter(isTestConfig);
    if (cfg.length) observations.push({ id: "testconf", detail: `动了测试配置：${cfg.slice(0, 3).join("、")}`, files: cfg });
    // 新增测试文件是 TDD 的正常动作，它不削弱任何既有断言——所以只有「动既有测试」才记一笔。
    const addedFilesSet = new Set(owned.flatMap((c) => addedFiles(root, c.sha)));
    const depOrTest = files.filter((f) => isPkg(f) || (isTestPath(f) && t.kind !== "test" && !addedFilesSet.has(f)));
    if (depOrTest.length) {
      observations.push({ id: "tests", detail: `动了依赖/既有测试：${depOrTest.slice(0, 3).join("、")}`, files: depOrTest });
    }
    // 项目上下文：该不该更新，机械判据说了算；更新了没有，要 agent 自己交代一句。
    // 有提醒就必须带 contextNote——这不是拦「过期」，是拦「假装没看见」。
    // 和 resolvedBy 同一个道理：失败不丢人，不解释怎么解决的才丢人。
    const drift = contextDrift(root, { addedFiles: [...addedFilesSet], changedFiles: files });
    if (drift.needsAttention) {
      for (const r of drift.reasons) {
        observations.push({ id: "context", code: r.id, detail: r.detail, fix: r.fix });
      }
      if (!String(input.contextNote ?? "").trim()) {
        const lines = drift.reasons.map((r) => `· ${r.detail}\n  → ${r.fix}`).join("\n");
        fail("E_CONTEXT_UNREVIEWED", "这次改动触碰了项目上下文没覆盖的东西，close 必须带 contextNote（一句话：更新了哪篇 / 为什么不用更新）", {
          reasons: drift.reasons,
          hint: `先看一眼这几条：\n${lines}\n\n带上这一句再 close：\n  CLI：devcontrol close ${t.id} --context-note "更新了 architecture.md 的目录说明"\n  MCP：task.close 加 contextNote 字段`,
        });
      }
    }
    } // ← 闭合上面 324 行的 if (!weak)：这段故意不缩进，别当成多余括号删掉（删了弱模式会跑 R0）

    mark("checks", `归属与 scope 检查通过（${files.length} 个文件 / ${lines} 行）`);

    // 干净判定（需要 git；弱模式没有这个能力）
    // 依赖/构建产物不算「脏」：装依赖、跑构建是开发中的常态，不该拦住收口。
    // 只放行未跟踪的那些；已被跟踪的文件照常要求干净（那是有人特意提交的）。
    if (!weak) {
      const lines = (args) =>
        statusPorcelain(root, ["--untracked-files=no", ...args])
          .split("\n")
          .filter((l) => l.length > 3)
          .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
      const dirty = lines(["--", ".", ":(exclude).devcontrol"]).filter((f) => !isVendorPath(f, root));
      if (dirty.length) fail("E_DIRTY_SCOPE", `工作树有未提交改动：${dirty.slice(0, 5).join("、")}`, { files: dirty });

      const untracked = statusPorcelain(root, ["--untracked-files=all", "--", ...t.scope])
        .split("\n")
        .filter((l) => l.length > 3)
        .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
        .filter((f) => f && !f.startsWith(".devcontrol/") && !isVendorPath(f, root));
      if (untracked.length) fail("E_DIRTY_SCOPE", `scope 内有未跟踪文件：${untracked.slice(0, 5).join("、")}`, { files: untracked });
    }

    // R2（核验 Agent 提交的证据，而不是内核自己跑）
    //
    // 工具不执行测试：测试是 Agent 的活。内核只回答一件事——
    // 「这段代码，真的跑过契约要求的那几条命令吗，而且过了吗」。
    //
    // 判据三条：① 证据是本任务记的；② 证据是在**当前这份代码**上产生的（内容指纹一致，
    // 防「先跑过、后来又改」）；③ 退出码满足契约里的谓词。
    // 为什么内核不该自己跑：那是把执行权、环境、超时、依赖安装全揽到工具身上，
    // 工具越重越容易和项目的真实工作方式打架（v5 就是这条路走岔的）。
    mark("evidence", "核对 Agent 提交的测试证据");
    const fpNow = fingerprint(root, t.scope, null);
    const runs = [];
    for (const [idx, item] of t.acceptance.entries()) {
      const { command, predicate } = parseAssertion(item.assertion);
      const same = db
        .prepare("SELECT * FROM runs WHERE task_id=? AND command=? AND fingerprint=? ORDER BY started_at DESC LIMIT 1")
        .get(t.id, command, fpNow);
      if (!same) {
        const older = db
          .prepare("SELECT * FROM runs WHERE task_id=? AND command=? ORDER BY started_at DESC LIMIT 1")
          .get(t.id, command);
        if (older) {
          last = "E_EVIDENCE_STALE";
          throw new DFError(
            "E_EVIDENCE_STALE",
            `${command} 的证据是旧代码上跑的（跑完之后又改了），重跑一次再收口：devcontrol run -- ${command}`,
            { command, runId: older.id },
          );
        }
        last = "E_NO_EVIDENCE";
        throw new DFError("E_NO_EVIDENCE", `没有 ${command} 的测试证据`, { command });
      }
      // verify 交付不产生提交，所以「证据是在哪份代码上跑出来的」必须就是现在这份。
      // 指纹只覆盖 scope 内的内容；代码要是在 scope 外被别人动过，指纹对不出来，但结果同样不算数。
      if (verify && same.head && head0 && same.head !== head0) {
        last = "E_EVIDENCE_STALE_HEAD";
        throw new DFError(
          "E_EVIDENCE_STALE_HEAD",
          `${command} 的证据是在 ${String(same.head).slice(0, 8)} 上跑的，当前 HEAD 已是 ${head0.slice(0, 8)}：verify 任务换过代码就得重跑：devcontrol run -- ${command}`,
          { command, runId: same.id, runHead: same.head, head: head0 },
        );
      }
      const passed = evaluate(predicate, { exit: same.exit_code, stdout: same.output });
      runs.push({ idx, runId: same.id, exit: same.exit_code, passed, command });
      mark("evidence-done", `证据 ${idx + 1}/${t.acceptance.length}：${command} ${passed ? "满足断言" : `不满足（exit ${same.exit_code}）`}`);
      if (!passed) {
        last = "E_ASSERTION_FAILED";
        throw new DFError(last, `证据不满足断言：${item.assertion}（exit ${same.exit_code}）`, {
          assertionIdx: idx,
          runId: same.id,
          exit: same.exit_code,
          runs,
        });
      }
    }

    // R4（弱模式没有提交链，跳过）
    if (!weak) {
      const notLanded = owned.filter((c) => !isAncestor(root, c.sha, "HEAD"));
      if (notLanded.length) throw new DFError("E_UNMERGED_WORK", "归属提交不在 HEAD 祖先链上", { commits: notLanded.map((c) => c.sha) });
    }

    // 交付说明：给了就校验并记录；没给这一版先记一条告警，不硬拦。
    // 硬拦要同时改造 40+ 处测试调用点，那是独立的一轮迁移；在那之前，
    // 这里既不伪造一条「完成结论」，也不让缺说明悄悄变成一条假账。
    let completion = null;
    let completionMissing = false;
    // 证据快照只取本次核验通过的那几条 run：不接受调用方自称「验证通过」。
    const runSnapshot = runs.map((r) => {
      const row = db.prepare("SELECT id,command,exit_code,head,fingerprint,log_sha256,started_at FROM runs WHERE id=?").get(r.runId);
      return {
        runId: row.id,
        assertionIdx: r.idx,
        command: row.command,
        exitCode: row.exit_code,
        passed: r.passed,
        head: row.head,
        fingerprint: row.fingerprint,
        logSha256: row.log_sha256,
        startedAt: row.started_at,
      };
    });
    const commitSnapshot = owned.map((c) => ({ sha: c.sha, subject: c.subject, patch: c.patch ?? null, files: c.files }));

    // 收口。时间戳只取一次：closed_at 和下面那条 close 事件必须是同一个时刻，
    // 否则「按 closed_at 归天」与「按事件时间归天」会在窗口边界上分家（T-127）。
    // 状态、归属、事件和交付记录必须同一个事务：只落一半，等于给 review 一份假账。
    const closedAt = now();
    const closed = tx(db, () => {
      const done = db
        .prepare("UPDATE tasks SET status='done', changed_lines=?, closed_by='evidence', closed_at=?, closing_at=NULL, closing_token=NULL, updated_at=? WHERE id=? AND status='doing' AND closing_token=?")
        .run(lines, closedAt, closedAt, t.id, token);
      if (done.changes !== 1) throw new DFError("E_BUSY", "任务状态已被改变");
      for (const c of owned) {
        if (c.patch) db.prepare("INSERT OR REPLACE INTO patch_ids(patch_id,task_id,commit_sha) VALUES(?,?,?)").run(c.patch, t.id, c.sha);
      }
      if (!completion) {
        try {
          completion = validateCompletionInput(input);
        } catch (error) {
          if (error.code !== "E_NEED_COMPLETION") throw error;
          completionMissing = true;
        }
      }
      const record = completion
        ? insertCompletion(db, {
            taskId: t.id,
            actor: actorOf(db, t.id),
            closedAt,
            closedBy: "evidence",
            ...completion,
            fingerprint: fpNow,
            runs: runSnapshot,
            commits: commitSnapshot,
            delivery: t.delivery ?? "code",
          })
        : null;
      if (observations.length) {
        logEvent(db, { actor: actorOf(db, t.id), action: "close.observed", taskId: t.id, at: closedAt, detail: observations.map((o) => o.detail).join("；") });
      }
      // 上下文那句话单独记一条：它和「又是哪条规范提醒了」不是一回事——
      // 这条是 agent 自己说的「我看见了、我更新了/我故意不改」，人要看得见它的原话。
      const ctxNote = String(input.contextNote ?? "").trim();
      if (ctxNote) {
        logEvent(db, { actor: actorOf(db, t.id), action: "close.context", taskId: t.id, at: closedAt, detail: ctxNote });
      }
      logEvent(db, {
        actor: actorOf(db, t.id),
        action: "close",
        taskId: t.id,
        at: closedAt,
        detail: weak
          ? `弱模式 · ${runs.length} 断言`
          : verify
            ? `verify 交付 · ${runs.length} 断言（无提交）`
            : `${lines} 行 / ${files.length} 文件 / ${runs.length} 断言${observations.length ? ` / ${observations.length} 条规范提醒` : ""}`,
      });
      return record;
    });
    mark("done", `${t.id} 收口完成，用时 ${Math.round((Date.now() - startedAt) / 100) / 10}s`);
    // 失败过才记坑：现象取最近一次失败事件，解法取 resolvedBy（上面已强制）
    let memory = null;
    if (rounds > 0 && resolvedBy) {
      const lastFail = db.prepare("SELECT code, detail FROM events WHERE task_id=? AND action='close.fail' ORDER BY id DESC LIMIT 1").get(t.id);
      memory = await rememberTaskPitfall(root, t, resolvedBy, lastFail ? `${lastFail.code}: ${lastFail.detail}` : null, memoryConfig(process.env, root));
    }
    if (memory?.status === "candidate") memory.hint = generalizeHint(memory.reasons ?? []);
    if (memory?.status === "candidate") memory.hint = generalizeHint(memory.reasons ?? []);
    // 收口之后工作树刚提交完、最干净——正是补托管文件的最好时机。
    // MCP 连上时那条路遇到「有在办任务」会跳过重扫（怕弄脏工作树），
    // 所以整个开发期间装的客户端只有这里能补上。托管文件该自愈，不该靠人记得跑 init。
    let agentFiles = [];
    try {
      agentFiles = refreshAgentFiles(root).changed;
    } catch {
      // 托管文件同步失败不该影响收口——它和这次交付无关
    }
    return {
      id: t.id,
      lines,
      files: files.length,
      runs,
      closedBy: "evidence",
      // 这次收口留下的交付记录：调用方直接拿它回报人，不用再查一次库
      completion: closed,
      // true = 这次收口没写交付说明，记录为空。CLI 会把该补的参数打出来，
      // 下一步（迁移完成后）这里会变成硬拦。
      completionMissing,
      commits: weak ? [] : owned.map((c) => c.sha),
      fingerprint: fpNow,
      // 规范对照：内核只报事实，不判违规。Owner 看这个决定要不要打回。
      observations,
      memory,
      memoryHint: memory?.hint ?? null,
      // 收口时顺手补的托管文件（MCP 连上时因为「有在办任务」被跳过的那次）
      agentFiles,
      weak,
      delivery: t.delivery ?? "code",
    };
  } catch (error) {
    last = last ?? error.code ?? "E_INTERNAL";
    mark("failed", `${last}：${String(error.message).slice(0, 120)}`);
    throw error;
  } finally {
    const cur = getTask(db, t0.id);
    if (cur && cur.status === "doing" && cur.closing_token === token && last && !ENV_ONLY_CODES.has(last)) {
      // 内核自己崩了：事件照样记（要看得见、要能上报），但不给 Agent 加轮次。
      // 早先这里一视同仁，于是 T-012 因为内核的 bug 被记了两轮返工，再撞一次就直接挂起——
      // 那是 Agent 手里解不开的东西（T-119）。
      if (FAULT_CODES.has(last)) {
        logEvent(db, { actor: actorOf(db, cur.id), action: "close.fail", taskId: cur.id, code: last, detail: "内核自身故障，不计入 Agent 轮次" });
      } else {
        const n = (cur.review_round ?? 0) + 1;
        const parked = n >= 3;
        if (parked) {
          db.prepare("UPDATE tasks SET review_round=?, status='parked', claimed_by=NULL, claim_expires_at=NULL WHERE id=?").run(n, cur.id);
        } else {
          db.prepare("UPDATE tasks SET review_round=?, status='doing' WHERE id=?").run(n, cur.id);
        }
        logEvent(db, { actor: actorOf(db, cur.id), action: "close.fail", taskId: cur.id, code: last, detail: `第 ${n} 次` });
      }
    }
    db.prepare("UPDATE tasks SET closing_at=NULL, closing_token=NULL WHERE id=? AND closing_token=?").run(t0.id, token);
  }
}

// ── bug.report / ask ──────────────────────────────────────────────────────

export function bugReport(db, input, actor = "agent") {
  return tx(db, () => {
    const repro = (input.repro ?? []).filter(Boolean);
    if (!String(input.title ?? "").trim()) fail("E_CONTRACT", "Bug 需要标题");
    if (!repro.length) fail("E_CONTRACT", "Bug 需要至少一步复现");
    const n = Number(metaGet(db, "counter:B") ?? 0) + 1;
    const id = `B-${String(n).padStart(3, "0")}`;
    db.prepare(
      "INSERT INTO bugs(id,requirement_id,title,symptom,expected,repro_json,attachments_json,severity,status,task_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(id, input.requirementId ?? null, String(input.title).trim(), String(input.symptom ?? ""), String(input.expected ?? ""), JSON.stringify(repro), JSON.stringify(input.attachments ?? []), input.severity ?? "P2", "new", null, "agent", now());
    db.prepare("INSERT INTO meta(key,value) VALUES('counter:B',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
    logEvent(db, { actor, action: "bug.report", detail: id });
    return { bugId: id };
  });
}

export function ask(db, input) {
  return tx(db, () => {
    const t = getTask(db, input.taskId);
    if (!t) fail("NOT_FOUND", `任务不存在：${input.taskId}`);
    // 三类问题，只有 C 类该占 Owner 的待办：
    //   decision（A）：技术选型 / 怎么拆 / 怎么修 —— 归 Agent 自己，别问；
    //   external（B）：依赖没装、服务挂了 —— 先自己重试 / 降级 / 等待，别把噪音丢给人；
    //   owner（C）   ：超范围、新权限、不可逆数据操作、产品方向、真金白银 —— 只有这类进待办。
    if (!input.kind) {
      // 不给 kind 就等于「让用户替我做判断」——那正是要禁掉的动作。
      // 宁可报错让它想清楚「这到底该不该找人」，也不要默认吐一条 Owner 待办。
      fail("E_ASK_NEEDS_KIND", "ask 必须说明这是哪类问题：decision（技术选择，自己定，不该问）/ external（外部阻塞，自己重试降级）/ owner（只有人能定：产品方向、权限、合同、不可逆操作）", {
        kinds: ["decision", "external", "owner"],
      });
    }
    const raw = String(input.kind ?? "owner").toLowerCase();
    const ALIAS = { a: "decision", technical: "decision", b: "external", blocked: "external", dependency: "external", c: "owner" };
    const kind = ["owner", "external", "decision"].includes(raw) ? raw : ALIAS[raw];
    if (!kind) {
      fail("INVALID_ARGUMENT", `ask 的 kind 只能是 owner / external / decision（收到 ${input.kind}）`, { kinds: ["owner", "external", "decision"] });
    }
    const actor = t.claimed_by ?? "agent";
    const question = String(input.question ?? "").slice(0, 300);
    if (kind === "decision") {
      fail("E_ASK_NOT_OWNER", "这类判断归你自己：技术选型、怎么拆任务、怎么修——做出决定，并在 close 的 changes / resolvedBy / contextNote 里交代清楚", { kind });
    }
    if (kind === "external") {
      // 不挂起任务、不占 Owner 待办：记一条事件就够，Agent 继续重试/降级/等待
      logEvent(db, { actor, action: "ask.external", taskId: t.id, detail: question });
      return { kind, questionId: null, guidance: "先自己重试 / 降级 / 等待；真的过不去（权限被拒、必须人装的依赖）再用 kind=owner 找人" };
    }
    const open = db.prepare("SELECT COUNT(*) c FROM questions WHERE task_id=? AND status='open'").get(t.id).c;
    if (open >= 3) {
      logEvent(db, { actor, action: "ask.quota", taskId: t.id, code: "E_QUOTA", detail: question });
      return { kind, questionId: null, quotaLeft: 0, note: "配额已满，只记事件" };
    }
    const n = Number(metaGet(db, "counter:Q") ?? 0) + 1;
    const id = `Q-${String(n).padStart(3, "0")}`;
    const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
    db.prepare("INSERT INTO questions(id,task_id,question,options_json,status,expires_at) VALUES(?,?,?,?,?,?)").run(id, t.id, question, JSON.stringify(input.options ?? []), "open", expires);
    db.prepare("INSERT INTO meta(key,value) VALUES('counter:Q',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
    db.prepare("UPDATE tasks SET status='parked', claimed_by=NULL, claim_expires_at=NULL WHERE id=? AND status='doing'").run(t.id);
    logEvent(db, { actor, action: "ask", taskId: t.id, detail: id });
    return { kind, questionId: id, expiresAt: expires, quotaLeft: 2 - open };
  });
}