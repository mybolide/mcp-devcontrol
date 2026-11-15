// devcontrol — claim / close 门禁（R0–R5，M0-lite）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logEvent, metaGet, tx } from "./db.js";
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
} from "./store.js";
import { contractCommands, parseAssertion, readContract } from "./contract.js";
import { fingerprint, inScope, sha256 } from "./fingerprint.js";
import { addedFiles, git, head, isAncestor, logCommits, numstat, patchId, statusPorcelain, trailers } from "./git.js";
import { evaluate, execCommand } from "./exec.js";
import { generalizeHint, memoryConfig, rememberTaskPitfall } from "./memory.js";

const R2WT = ".devcontrol/r2-wt";
const ENV_ONLY = new Set(["E_DIRTY_SCOPE", "E_BUSY", "E_TIMEOUT"]);

export function intersect(a, b) {
  return a.some((x) =>
    b.some((y) => {
      const p = String(x).replace(/\/+$/, "");
      const q = String(y).replace(/\/+$/, "");
      return p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);
    }),
  );
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
    if (!allowed.includes(command)) fail("E_CONTRACT", `命令不在契约白名单：${command}`, { allowed });
    if (typeof item.deriveFrom !== "number") fail("E_CONTRACT", "验收缺少 deriveFrom");
  }
}

// ── task.create ─────────────────────────────────────────────────────────────

export function taskCreate(db, root, input) {
  return tx(db, () => {
    const req = getReq(db, input.requirementId);
    if (!req || req.status !== "approved") fail("E_NEED_APPROVED", `需求未批准：${input.requirementId}`);
    const p = getPath(db, input.pathId);
    if (!p || p.status !== "approved") fail("E_NEED_APPROVED", `Path ${input.pathId} 未批准`);
    const body = contractOf(db, root, p);
    const scope = Array.isArray(input.scope) && input.scope.length ? input.scope : p.allowedPaths;
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
    const id = `T-${String(n).padStart(3, "0")}`;
    db.prepare(
      "INSERT INTO tasks(id,requirement_id,path_id,kind,title,status,scope_json,acceptance_json,depends_on_json,budget_lines,base_head,contract_hash,contract_commit,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      req.id,
      p.id,
      kind,
      title,
      "backlog",
      JSON.stringify(scope),
      JSON.stringify(acceptance),
      JSON.stringify(dependsOn),
      Number(input.budgetLines ?? 400),
      p.contract_commit ?? "",
      p.hash,
      p.contract_commit ?? "",
      now(),
      now(),
    );
    db.prepare("INSERT INTO meta(key,value) VALUES('counter:T',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
    logEvent(db, { action: "task.create", taskId: id, detail: title });
    return getTask(db, id);
  });
}

// ── task.claim ─────────────────────────────────────────────────────────────

export function taskClaim(db, root, input, actor = "agent") {
  return tx(db, () => {
    const t = getTask(db, input.id);
    if (!t) fail("NOT_FOUND", `任务不存在：${input.id}`);
    if (t.status === "done") fail("E_ILLEGAL_TRANSITION", `${t.id} 已完成`);
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
    // 注意：这里必须传 t.id，否则 id<>NULL 恒不成立，相交检查会形同虚设（并发探针发现的）
    const doing = db.prepare("SELECT * FROM tasks WHERE status='doing' AND id<>? AND closing_token IS NULL").all(t.id).map((r) => JSON.parse(r.scope_json));
    for (const other of doing) if (intersect(t.scope, other)) fail("E_SCOPE_OVERLAP", "与其他在办任务 scope 相交", { conflict: other });
    const mine = db.prepare("SELECT id FROM tasks WHERE status='doing' AND claimed_by=? AND id<>?").all(actor, t.id);
    if (mine.length) fail("E_WIP_LIMIT", `你手上还有 ${mine[0].id}`, { holding: mine[0].id });
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
    const res = db
      .prepare(
        "UPDATE tasks SET status='doing', claimed_by=?, claimed_at=?, claim_expires_at=?, claim_fingerprint=?, contract_hash=?, contract_commit=?, base_head=?, updated_at=? WHERE id=? AND status IN ('backlog','parked') AND (claimed_by IS NULL OR claim_expires_at < ?)",
      )
      .run(actor, now(), exp, fp, p.hash, p.contract_commit ?? "", p.contract_commit ?? "", now(), t.id, now());
    if (res.changes !== 1) fail("E_CLAIMED_BY_OTHER", "任务已被他人领取");
    logEvent(db, { action: "task.claim", taskId: t.id, detail: actor });
    return {
      id: t.id,
      title: t.title,
      scope: t.scope,
      acceptance: t.acceptance,
      dependsOn: t.dependsOn,
      contractHash: p.hash,
      contractCommit: p.contract_commit,
      baseHead: p.contract_commit ?? "",
      budgetLines: t.budget_lines,
      claimExpiresAt: exp,
      testCmds: contractCommands(body),
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
    logEvent(db, { action: "task.renew", taskId: t.id, detail: actor });
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
  return /^chore\(devcontrol\): init$/.test(subject) && c.files.length > 0 && c.files.every((f) => INIT_MANAGED.some((p) => f === p || f.startsWith(p)));
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

function recordRun(db, { taskId, idx, command, result, head0, fp }) {
  const out = `${result.stdout}\n${result.stderr}`;
  const id = `run-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO runs(id,task_id,assertion_idx,command,exit_code,head,fingerprint,log_sha256,output,started_at,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, taskId, idx, command, result.exit, head0, fp, sha256(out), out.slice(0, 20000), now(), result.durationMs);
  return id;
}

function prepareWorktree(root, { weak = false } = {}) {
  fs.rmSync(path.join(root, R2WT), { recursive: true, force: true });
  try {
    git(root, ["worktree", "prune"]);
  } catch {
    /* ignore */
  }
  try {
    git(root, ["worktree", "add", "--detach", "--force", R2WT, "HEAD"]);
    return path.join(root, R2WT);
  } catch (error) {
    if (weak) return root; // 弱模式没有 git，只能在当前目录跑
    // 干净检出建不出来就不能假装证据有效：fail-closed
    throw new DFError("E_NO_CLEAN_WORKTREE", `干净检出创建失败：${String(error.message).slice(0, 200)}`, {
      hint: "git worktree 不可用（浅克隆/权限/磁盘）；R2 必须在干净检出里跑，不能退化到脏工作树",
    });
  }
}

function linkNodeModules(root, cwd) {
  if (cwd === root) return;
  const lock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].find((f) => fs.existsSync(path.join(root, f)));
  if (!lock) return;
  const a = path.join(root, lock);
  const b = path.join(cwd, lock);
  if (!fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b))) return;
  const nm = path.join(root, "node_modules");
  const target = path.join(cwd, "node_modules");
  if (!fs.existsSync(nm) || fs.existsSync(target)) return;
  try {
    fs.symlinkSync(nm, target, "junction");
  } catch {
    /* 退化 */
  }
}

export async function taskClose(db, root, input, opts = {}) {
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
  try {
    const t = getTask(db, t0.id);
    const p = getPath(db, t.path_id);
    const body = readContract(root, t.contract_commit, p.id, t.contract_hash).body;
    // scope 可能在 doing 期间被 adjust 改过：收口前必须重新对照契约
    within(t.scope, body.allowedPaths);
    // 弱模式（无 git）：没有 base_head，跳过提交归属与 diff 统计，只跑验收 + 指纹
    const weak = !t.base_head;
    const head0 = weak ? null : head(root);
    let files = [];
    let lines = 0;
    let owned = [];
    if (!weak) {

    // R0
    const commits = decorate(root, logCommits(root, `${t.base_head}..HEAD`));
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
    if (!owned.length) fail("E_NO_DELIVERY", "区间内没有本任务的提交", { hint: "devcontrol commit -m ..." });

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
    if (pathUsed + lines > Number(body.budgetLines ?? 1200) && !waiveFor(db, t.id, "E_DIFF_BUDGET")) fail("E_DIFF_BUDGET", `Path 累计超预算`, { scope: "path" });
    if (lines > t.budget_lines && !waiveFor(db, t.id, "E_DIFF_BUDGET")) fail("E_DIFF_BUDGET", `任务累计 ${lines} 行 > ${t.budget_lines}`);
    const todos = owned
      .flatMap((c) => git(root, ["diff", "-m", "--first-parent", `${c.sha}^..${c.sha}`]).split("\n"))
      .filter((l) => /^\+/.test(l) && /(TODO|FIXME|HACK|XXX)/.test(l) && !l.includes(t.id));
    if (todos.length) fail("E_LINT_TODO", "新增 TODO 未带任务号", { lines: todos.slice(0, 5) });
    const cfg = files.filter(isTestConfig);
    if (cfg.length && !waiveFor(db, t.id, "E_TEST_CONFIG_TOUCH")) fail("E_TEST_CONFIG_TOUCH", "改动了测试配置", { files: cfg });
    const depOrTest = files.filter((f) => isPkg(f) || (isTestPath(f) && t.kind !== "test"));
    if (depOrTest.length && !waiveFor(db, t.id, "E_DEP_OR_TEST_TOUCH")) fail("E_DEP_OR_TEST_TOUCH", "改动了依赖或测试", { files: depOrTest });
    }

    // 干净判定（需要 git；弱模式没有这个能力）
    if (!weak) {
      if (statusPorcelain(root, ["--untracked-files=no", "--", ".", ":(exclude).devcontrol"])) fail("E_DIRTY_SCOPE", "工作树有未提交改动");
      if (statusPorcelain(root, ["--untracked-files=all", "--", ...t.scope])) fail("E_DIRTY_SCOPE", "scope 内有未跟踪文件");
    }

    // R2（干净检出内重跑）
    const fp0 = fingerprint(root, t.scope, head0);
    const cwd = prepareWorktree(root, { weak });
    linkNodeModules(root, cwd);
    const runs = [];
    for (const [idx, item] of t.acceptance.entries()) {
      const { command, predicate } = parseAssertion(item.assertion);
      const result = await execCommand(cwd, command, { env: { DEVCONTROL_TASK: t.id } });
      const runId = recordRun(db, { taskId: t.id, idx, command, result, head0: head0 ?? "", fp: fp0 });
      const passed = evaluate(predicate, result);
      runs.push({ idx, runId, exit: result.exit, passed, command });
      if (!passed) {
        last = result.exit === 124 ? "E_TIMEOUT" : "E_ASSERTION_FAILED";
        throw new DFError(last, `断言失败：${item.assertion}（exit ${result.exit}）`, { assertionIdx: idx, runId, exit: result.exit, runs });
      }
    }

    // R3
    if (!weak && head(root) !== head0) throw new DFError("E_EVIDENCE_DRIFT", "R2 期间 HEAD 被移动", {});
    if (fingerprint(root, t.scope, head0) !== fp0) throw new DFError("E_EVIDENCE_DRIFT", "R2 期间工作树被改动", { files });

    // R4（弱模式没有提交链，跳过）
    if (!weak) {
      const notLanded = owned.filter((c) => !isAncestor(root, c.sha, "HEAD"));
      if (notLanded.length) throw new DFError("E_UNMERGED_WORK", "归属提交不在 HEAD 祖先链上", { commits: notLanded.map((c) => c.sha) });
    }

    // 收口
    const done = db
      .prepare("UPDATE tasks SET status='done', changed_lines=?, closed_by='rerun', closed_at=?, closing_at=NULL, closing_token=NULL, updated_at=? WHERE id=? AND status='doing' AND closing_token=?")
      .run(lines, now(), now(), t.id, token);
    if (done.changes !== 1) throw new DFError("E_BUSY", "任务状态已被改变");
    for (const code of ["E_TEST_CONFIG_TOUCH", "E_DEP_OR_TEST_TOUCH", "E_DIFF_BUDGET"]) consumeWaive(db, t.id, code);
    for (const c of owned) {
      if (c.patch) db.prepare("INSERT OR REPLACE INTO patch_ids(patch_id,task_id,commit_sha) VALUES(?,?,?)").run(c.patch, t.id, c.sha);
    }
    logEvent(db, { action: "close", taskId: t.id, detail: weak ? `弱模式 · ${runs.length} 断言` : `${lines} 行 / ${files.length} 文件 / ${runs.length} 断言` });
    // 失败过才记坑：现象取最近一次失败事件，解法取 resolvedBy（上面已强制）
    let memory = null;
    if (rounds > 0 && resolvedBy) {
      const lastFail = db.prepare("SELECT code, detail FROM events WHERE task_id=? AND action='close.fail' ORDER BY id DESC LIMIT 1").get(t.id);
      memory = await rememberTaskPitfall(root, t, resolvedBy, lastFail ? `${lastFail.code}: ${lastFail.detail}` : null, memoryConfig(process.env, root));
    }
    if (memory?.status === "candidate") memory.hint = generalizeHint(memory.reasons ?? []);
    return { id: t.id, lines, files: files.length, runs, closedBy: "rerun", commits: weak ? [] : owned.map((c) => c.sha), fingerprint: fp0, memory, memoryHint: memory?.hint ?? null, weak };
  } catch (error) {
    last = last ?? error.code ?? "E_INTERNAL";
    throw error;
  } finally {
    const cur = getTask(db, t0.id);
    if (cur && cur.status === "doing" && cur.closing_token === token && last && !ENV_ONLY.has(last)) {
      const n = (cur.review_round ?? 0) + 1;
      db.prepare("UPDATE tasks SET review_round=?, status=? WHERE id=?").run(n, n >= 3 ? "parked" : "doing", cur.id);
      logEvent(db, { action: "close.fail", taskId: cur.id, code: last, detail: `第 ${n} 次` });
    }
    db.prepare("UPDATE tasks SET closing_at=NULL, closing_token=NULL WHERE id=? AND closing_token=?").run(t0.id, token);
  }
}

// ── bug.report / ask ──────────────────────────────────────────────────────

export function bugReport(db, input) {
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
    logEvent(db, { action: "bug.report", detail: id });
    return { bugId: id };
  });
}

export function ask(db, input) {
  return tx(db, () => {
    const t = getTask(db, input.taskId);
    if (!t) fail("NOT_FOUND", `任务不存在：${input.taskId}`);
    const open = db.prepare("SELECT COUNT(*) c FROM questions WHERE task_id=? AND status='open'").get(t.id).c;
    if (open >= 3) {
      logEvent(db, { action: "ask.quota", taskId: t.id, code: "E_QUOTA", detail: input.question });
      return { questionId: null, quotaLeft: 0, note: "配额已满，只记事件" };
    }
    const n = Number(metaGet(db, "counter:Q") ?? 0) + 1;
    const id = `Q-${String(n).padStart(3, "0")}`;
    const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
    db.prepare("INSERT INTO questions(id,task_id,question,options_json,status,expires_at) VALUES(?,?,?,?,?,?)").run(id, t.id, String(input.question ?? "").slice(0, 300), JSON.stringify(input.options ?? []), "open", expires);
    db.prepare("INSERT INTO meta(key,value) VALUES('counter:Q',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
    db.prepare("UPDATE tasks SET status='parked', claimed_by=NULL, claim_expires_at=NULL WHERE id=? AND status='doing'").run(t.id);
    logEvent(db, { action: "ask", taskId: t.id, detail: id });
    return { questionId: id, expiresAt: expires, quotaLeft: 2 - open };
  });
}