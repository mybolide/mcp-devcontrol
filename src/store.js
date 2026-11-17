// devcontrol — 存储与 Owner 侧动作
import fs from "node:fs";
import path from "node:path";
import { logEvent, metaGet, metaSet, nextId, tx } from "./db.js";
import { commitContract, contractBody, parseAssertion, readContract } from "./contract.js";
import { inScope } from "./fingerprint.js";
import { logCommits, numstat, trailers } from "./git.js";
import { sha256 } from "./fingerprint.js";
import { assertionCommand, detectTestCmds, retargetAssertion } from "./testcmd.js";

export const now = () => new Date().toISOString();
export const MIN = 60_000;

export class DFError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
export const fail = (code, message, data) => {
  throw new DFError(code, message, data);
};

const J = (v, d) => {
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};

export function mapReq(r) {
  return r && { ...r, acceptance: J(r.acceptance_json, []) };
}
export function mapPath(p) {
  return p && { ...p, allowedPaths: J(p.allowed_paths_json, []), testCmds: J(p.test_cmds_json, []) };
}
export function mapTask(t) {
  return (
    t && {
      ...t,
      scope: J(t.scope_json, []),
      acceptance: J(t.acceptance_json, []),
      dependsOn: J(t.depends_on_json, []),
    }
  );
}
export function mapBug(b) {
  return b && { ...b, repro: J(b.repro_json, []), attachments: J(b.attachments_json, []) };
}

export function getReq(db, id) {
  return mapReq(db.prepare("SELECT * FROM requirements WHERE id=?").get(id));
}
export function getPath(db, id) {
  return mapPath(db.prepare("SELECT * FROM paths WHERE id=?").get(id));
}
export function getTask(db, id) {
  return mapTask(db.prepare("SELECT * FROM tasks WHERE id=?").get(id));
}
export function getBug(db, id) {
  return mapBug(db.prepare("SELECT * FROM bugs WHERE id=?").get(id));
}
export function listTasks(db) {
  return db.prepare("SELECT * FROM tasks ORDER BY id").all().map(mapTask);
}
export function listReqs(db) {
  return db.prepare("SELECT * FROM requirements ORDER BY id").all().map(mapReq);
}
export function listPaths(db) {
  return db.prepare("SELECT * FROM paths ORDER BY id").all().map(mapPath);
}
export function listBugs(db) {
  return db.prepare("SELECT * FROM bugs ORDER BY id").all().map(mapBug);
}
export function listDocs(db) {
  return db.prepare("SELECT * FROM docs ORDER BY id").all();
}
/**
 * 纪律三数：被拦多少次、返工多少轮、绕过多少次。
 * 这是「内核到底有没有生效」的可核对证据，不靠人回忆。
 */
/**
 * 哪些拒绝算「补一步就好」，不算纪律问题。
 * 忘了跑测试、工作树脏这类不该和「改到 scope 外面」记在同一个数里。
 */
export const ENV_ONLY_CODES = new Set([
  "E_DIRTY_SCOPE",
  "E_BUSY",
  "E_TIMEOUT",
  "E_NO_EVIDENCE",
  "E_EVIDENCE_STALE",
  "E_NO_DELIVERY",
]);

/**
 * 记一次拒绝。CLI 和 MCP 都走这里，否则「被拦」只算得到一半路径上的事。
 * 记账失败不能把错误提示也弄丢，所以调用方一律用 try 包住。
 */
export function logRejection(db, actor, code) {
  logEvent(db, { actor: actor || "agent", action: "rejected", code, detail: ENV_ONLY_CODES.has(code) ? "env-only" : "" });
}

export function disciplineStats(db) {
  // 「被拦」= 所有实质拒绝 + 收口失败。早先只数 close.fail，于是 claim/commit 阶段
  // 的拒绝一次都不进这个数，指标恒为 0，等于自证无效（T-097）。
  const blocked = db
    .prepare(
      "SELECT COUNT(*) AS c FROM events WHERE action='close.fail' OR (action='rejected' AND COALESCE(detail,'') <> 'env-only')",
    )
    .get().c;
  const envOnly = db.prepare("SELECT COUNT(*) AS c FROM events WHERE action='rejected' AND detail='env-only'").get().c;
  const rework = db.prepare("SELECT COALESCE(SUM(review_round),0) AS c FROM tasks").get().c;
  const bypassed = db.prepare("SELECT COUNT(*) AS c FROM events WHERE action='override'").get().c;
  const done = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status='done'").get().c;
  return { blocked, envOnly, rework, bypassed, done };
}

/** 证据流：Agent 跑过的验收命令/退出码/HEAD/指纹，可复核 */
export function listRuns(db, limit = 20) {
  return db
    .prepare(
      `SELECT r.id, r.task_id, t.title AS task_title, r.assertion_idx, r.command, r.exit_code,
              r.head, r.fingerprint, r.log_sha256, r.started_at, r.duration_ms
         FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
        ORDER BY r.started_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function listQuestions(db) {
  return db.prepare("SELECT * FROM questions ORDER BY id").all();
}

export function taskExists(db, id) {
  return Boolean(db.prepare("SELECT 1 FROM tasks WHERE id=?").get(id));
}

/** 惰性回收：过期 doing → backlog（closing 中的不动） */
export function recycleExpired(db) {
  const rows = db
    .prepare("SELECT id, claimed_by FROM tasks WHERE status='doing' AND closing_token IS NULL AND claim_expires_at < ?")
    .all(now());
  for (const row of rows) {
    db.prepare("UPDATE tasks SET status='backlog', claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL, updated_at=? WHERE id=?").run(now(), row.id);
    logEvent(db, { actor: "system", action: "recycle", taskId: row.id, code: "E_CLAIM_STALE", detail: `接管 ${row.claimed_by ?? "?"} 的过期任务` });
  }
  return rows.length;
}

/** 一次性 waive：override mode=waive 写入，close 消费 */
export function setWaive(db, taskId, code) {
  metaSet(db, `waive:${taskId}:${code}`, "1");
}
export function waiveFor(db, taskId, code) {
  return metaGet(db, `waive:${taskId}:${code}`) === "1";
}
export function consumeWaive(db, taskId, code) {
  db.prepare("DELETE FROM meta WHERE key=?").run(`waive:${taskId}:${code}`);
}

// ── Owner：需求 / Bug / 文档 ────────────────────────────────────────────────

export function reqIntake(db, root, input) {
  return tx(db, () => {
    const type = input.type ?? "requirement";
    if (type === "doc") {
      const rel = String(input.path ?? "").trim();
      const abs = path.resolve(root, rel);
      if (!rel || !fs.existsSync(abs)) fail("E_CONTRACT", `文档不存在：${rel}`);
      // 不允许登记仓库外的文件（`..`、绝对路径、符号链接）：否则 /api/state 会去读它并泄露内容哈希
      if (!abs.startsWith(path.resolve(root) + path.sep)) fail("E_CONTRACT", `文档必须在仓库内：${rel}`);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) fail("E_CONTRACT", `不登记符号链接：${rel}`);
      if (!st.isFile()) fail("E_CONTRACT", `不是普通文件：${rel}`);
      if (st.size > 2 * 1024 * 1024) fail("E_CONTRACT", `文档过大（>2MB）：${rel}`);
      const id = nextId(db, "D");
      db.prepare("INSERT INTO docs(id,requirement_id,path,sha256,title,kind,registered_at) VALUES(?,?,?,?,?,?,?)").run(
        id,
        input.requirementId ?? null,
        rel,
        sha256(fs.readFileSync(abs)),
        input.title ?? path.basename(rel),
        input.kind ?? "spec",
        now(),
      );
      logEvent(db, { actor: "owner", channel: "owner", action: "doc.intake", detail: rel });
      return { id, type };
    }
    if (type === "bug") {
      const id = nextId(db, "B");
      db.prepare(
        "INSERT INTO bugs(id,requirement_id,title,symptom,expected,repro_json,attachments_json,severity,status,task_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        input.requirementId ?? null,
        String(input.title ?? "").trim(),
        String(input.symptom ?? "").trim(),
        String(input.expected ?? "").trim(),
        JSON.stringify(input.repro ?? []),
        JSON.stringify(input.attachments ?? []),
        input.severity ?? "P2",
        "new",
        null,
        "owner",
        now(),
      );
      logEvent(db, { actor: "owner", channel: "owner", action: "bug.intake", detail: input.title ?? "" });
      return { id, type };
    }
    const acceptance = (input.acceptance ?? []).map((a) => (typeof a === "string" ? a : a.assertion)).filter(Boolean);
    if (!acceptance.length) fail("E_CONTRACT", "需求至少要有一条可观测断言");
    for (const a of acceptance) parseAssertion(a);
    const id = nextId(db, "FR");
    db.prepare(
      "INSERT INTO requirements(id,title,goal,acceptance_json,status,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, String(input.title ?? "").trim(), String(input.goal ?? "").trim(), JSON.stringify(acceptance), "draft", now());
    logEvent(db, { actor: "owner", channel: "owner", action: "req.intake", detail: input.title ?? "" });
    return { id, type };
  });
}

/** 一键批准：需求 + Path 一起冻结，写契约提交 */
export function reqApprove(db, root, input) {
  return tx(db, () => {
    const req = getReq(db, input.requirementId);
    if (!req) fail("E_NEED_APPROVED", `需求不存在：${input.requirementId}`);
    const p = getPath(db, input.pathId);
    if (!p) fail("E_NEED_APPROVED", `Path 不存在：${input.pathId}`);
    // Path 是「文件区域 + 冻结命令」，不是某个需求的私有物：多个需求可以共用同一条 Path。
    // 已批准过就只重新绑定（契约里记下这次是哪条需求批准的），不再报 E_ILLEGAL_TRANSITION。
    const expected = sha256(Buffer.from(JSON.stringify(req.acceptance)));
    if (input.acceptanceHashPrefix && !expected.startsWith(input.acceptanceHashPrefix)) {
      fail("E_HASH_MISMATCH", `哈希前 8 位不符：${expected.slice(0, 8)}`);
    }
    // Owner 在需求验收里写的命令，必须一起冻进契约：只按 Path 原来采到的那几条冻结，
    // 等于把 Owner 明说的验收（例如「构建也要过」）静默丢掉，之后任何任务想用它都会被 E_CONTRACT 拦住。
    const wanted = req.acceptance.map((a) => assertionCommand(a)).filter(Boolean);
    const testCmds = [...new Set([...p.testCmds, ...wanted])];
    const body = contractBody({
      pathId: p.id,
      requirementId: req.id,
      allowedPaths: p.allowedPaths,
      allowNewFiles: Boolean(p.allow_new_files),
      testCmds,
      budgetLines: p.budget_lines,
    });
    const weak = metaGet(db, "mode") === "weak";
    const { sha, hash } = commitContract(root, body, "approve", { weak });
    db.prepare("UPDATE requirements SET status='approved', approved_at=? WHERE id=?").run(now(), req.id);
    db.prepare("UPDATE paths SET requirement_id=?, status='approved', hash=?, contract_commit=?, test_cmds_json=?, approved_at=? WHERE id=?").run(
      req.id,
      hash,
      sha,
      JSON.stringify(testCmds),
      now(),
      p.id,
    );
    logEvent(db, { actor: "owner", channel: "owner", action: "req.approve", detail: `${req.id} + ${p.id} @ ${sha ? sha.slice(0, 8) : "弱模式"}` });
    return { requirementId: req.id, pathId: p.id, contractCommit: sha, hash };
  });
}

export function reqAmend(db, root, input) {
  return tx(db, () => {
    const req = getReq(db, input.requirementId);
    if (!req) fail("E_NEED_APPROVED", `需求不存在：${input.requirementId}`);
    const acceptance = input.acceptance
      ? input.acceptance.map((a) => (typeof a === "string" ? a : a.assertion)).filter(Boolean)
      : req.acceptance;
    for (const a of acceptance) parseAssertion(a);
    const paths = listPaths(db).filter((p) => p.requirement_id === req.id);
    const touchesPaths = Boolean(input.allowedPaths);
    db.prepare("UPDATE requirements SET acceptance_json=?, status='building' WHERE id=?").run(JSON.stringify(acceptance), req.id);
    const affected = [];
    for (const p of paths) {
      const allowed = input.allowedPaths ?? p.allowedPaths;
      const body = contractBody({
        pathId: p.id,
        requirementId: req.id,
        allowedPaths: allowed,
        allowNewFiles: Boolean(p.allow_new_files),
        testCmds: p.testCmds,
        budgetLines: p.budget_lines,
      });
      const { sha, hash } = commitContract(root, body, "amend", { weak: metaGet(db, "mode") === "weak" });
      db.prepare("UPDATE paths SET allowed_paths_json=?, hash=?, contract_commit=?, status=? WHERE id=?").run(
        JSON.stringify(allowed),
        hash,
        sha,
        touchesPaths ? "draft" : "approved",
        p.id,
      );
      const doing = db.prepare("SELECT id FROM tasks WHERE path_id=? AND status='doing' AND closing_token IS NULL").all(p.id);
      for (const t of doing) {
        db.prepare("UPDATE tasks SET status='backlog', claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL, contract_hash=?, contract_commit=?, base_head=?, updated_at=? WHERE id=?").run(
          hash,
          sha,
          sha,
          now(),
          t.id,
        );
        affected.push(t.id);
      }
    }
    logEvent(db, { actor: "owner", channel: "owner", action: "req.amend", detail: `${req.id}${touchesPaths ? " (path → draft)" : ""}` });
    return { requirementId: req.id, affectedTasks: affected, pathStatus: touchesPaths ? "draft" : "approved" };
  });
}

/**
 * Owner：调一条 Path 的改动预算。
 * 项目会长大，1200 行这种数字不可能一次定死；但改预算必须留痕（写进契约、进审计），
 * 而且只影响之后领取的任务——在办任务仍按领取时固定的那份契约算（契约 pin 在 claim 上）。
 */
export function pathAdjust(db, root, input) {
  return tx(db, () => {
    const p = listPaths(db).find((x) => x.id === input.pathId);
    if (!p) fail("NOT_FOUND", `Path 不存在：${input.pathId}`);
    const budget = Number(input.budgetLines);
    if (!Number.isFinite(budget) || budget < 100) fail("E_CONTRACT", "预算至少 100 行——再小会把正常改动也拦掉");
    const reason = String(input.reason ?? "").trim();
    if (reason.length < 12) fail("E_CONTRACT", `调预算要写理由（至少 12 字，现在 ${reason.length} 字）：以后才知道为什么放宽`);
    const body = contractBody({
      pathId: p.id,
      requirementId: p.requirement_id,
      allowedPaths: p.allowedPaths,
      allowNewFiles: Boolean(p.allow_new_files),
      testCmds: p.testCmds,
      budgetLines: budget,
    });
    const { sha, hash } = commitContract(root, body, "amend", { weak: metaGet(db, "mode") === "weak" });
    db.prepare("UPDATE paths SET budget_lines=?, hash=?, contract_commit=? WHERE id=?").run(budget, hash, sha, p.id);
    logEvent(db, { actor: "owner", channel: "owner", action: "path.adjust", detail: `${p.id} 预算 ${p.budget_lines} → ${budget}：${reason}` });
    return { pathId: p.id, from: p.budget_lines, to: budget, contractCommit: sha };
  });
}

/**
 * Owner：重新采验收命令（`path.retest`）。
 *
 * 为什么需要它：契约里的 testCmds 是批准那一刻冻的，但项目会变——
 * test 脚本从 `node --test tests/` 换成 `node --test`（Node 24 不认目录参数），
 * 或者从 npm 换成 pnpm。命令一过期，收口跑的就是一条不存在的命令，Agent 只能干瞪眼。
 *
 * 只换命令、不改谓词：谓词是「怎样算通过」，那是验收标准，要动得走 req.amend。
 * 还没开工的任务跟着改断言；已经在办的不动（它 pin 了旧契约），交给 Owner 决定。
 */
export function pathRetest(db, root, input) {
  return tx(db, () => {
    const p = listPaths(db).find((x) => x.id === input.pathId);
    if (!p) fail("NOT_FOUND", `Path 不存在：${input.pathId}`);
    const detected = detectTestCmds(root);
    const next = (Array.isArray(input.testCmds) && input.testCmds.length ? input.testCmds : detected.cmds)
      .map((c) => String(c).trim())
      .filter(Boolean);
    if (!next.length) {
      fail("E_NO_TEST_CMD", `采不到验收命令：${detected.note ?? detected.source}`, { source: detected.source });
    }
    const reason = String(input.reason ?? "").trim();
    if (reason.length < 12) fail("E_CONTRACT", `重采命令要写理由（至少 12 字，现在 ${reason.length} 字）：以后才知道为什么换了`);
    const body = contractBody({
      pathId: p.id,
      requirementId: p.requirement_id,
      allowedPaths: p.allowedPaths,
      allowNewFiles: Boolean(p.allow_new_files),
      testCmds: next,
      budgetLines: p.budget_lines,
    });
    const { sha, hash } = commitContract(root, body, "amend", { weak: metaGet(db, "mode") === "weak" });
    db.prepare("UPDATE paths SET test_cmds_json=?, hash=?, contract_commit=? WHERE id=?").run(JSON.stringify(next), hash, sha, p.id);

    // 还没开工的任务（backlog）跟着换命令：它们自己的 acceptance 里也写着旧的命令原文
    const cmd = next[0];
    const retargeted = [];
    const stuck = [];
    for (const t of listTasks(db).filter((x) => x.path_id === p.id)) {
      if (!t.acceptance.length) continue;
      const needs = t.acceptance.some((a) => !next.includes(assertionCommand(a.assertion)));
      if (!needs) continue;
      if (t.status !== "backlog" && t.status !== "parked") {
        stuck.push(t.id);
        continue;
      }
      const acceptance = t.acceptance.map((a) =>
        next.includes(assertionCommand(a.assertion)) ? a : { ...a, assertion: retargetAssertion(a.assertion, cmd) },
      );
      db.prepare("UPDATE tasks SET acceptance_json=?, contract_hash=?, contract_commit=?, updated_at=? WHERE id=?").run(
        JSON.stringify(acceptance),
        hash,
        sha,
        now(),
        t.id,
      );
      retargeted.push(t.id);
    }
    logEvent(db, {
      actor: "owner",
      channel: "owner",
      action: "path.retest",
      detail: `${p.id} 命令 ${JSON.stringify(p.testCmds)} → ${JSON.stringify(next)}（${detected.source}）：${reason}`,
    });
    return { pathId: p.id, from: p.testCmds, to: next, source: detected.source, contractCommit: sha, retargeted, stuck };
  });
}

// ── Owner：任务动作 ────────────────────────────────────────────────────────

export function taskAdjust(db, root, input) {
  return tx(db, () => {
    const t = getTask(db, input.taskId);
    if (!t) fail("NOT_FOUND", `任务不存在：${input.taskId}`);
    const scope = input.scope ?? t.scope;
    const budget = input.budgetLines ?? t.budget_lines;
    // 收紧/放宽 scope 都不能越过契约：真想改 allowed_paths 得走 req.amend（Owner 重新批准）
    const p = getPath(db, t.path_id);
    if (p?.contract_commit || p?.hash) {
      const body = readContract(root, t.contract_commit || p.contract_commit, p.id, t.contract_hash || p.hash).body;
      for (const s of scope) {
        const probe = `${String(s).replace(/\/+$/, "")}/x`;
        if (!body.allowedPaths.some((allowed) => inScope(probe, [allowed]))) {
          fail("E_SCOPE_VIOLATION", `scope ${s} 超出 Path 契约的 allowed_paths`, { allowed: body.allowedPaths });
        }
      }
    }
    db.prepare("UPDATE tasks SET scope_json=?, budget_lines=?, updated_at=? WHERE id=?").run(
      JSON.stringify(scope),
      Number(budget),
      now(),
      t.id,
    );
    logEvent(db, { actor: "owner", channel: "owner", action: "task.adjust", taskId: t.id, detail: input.reason ?? "" });
    return { taskId: t.id, scope, budgetLines: budget };
  });
}

export function taskReopen(db, input) {
  return tx(db, () => {
    const t = getTask(db, input.taskId);
    if (!t) fail("NOT_FOUND", `任务不存在：${input.taskId}`);
    if (!["done", "parked"].includes(t.status)) fail("E_ILLEGAL_TRANSITION", `${t.id} 当前 ${t.status}，不能打回`);
    db.prepare("UPDATE tasks SET status='backlog', closed_by=NULL, closed_at=NULL, review_round=0, updated_at=? WHERE id=?").run(now(), t.id);
    logEvent(db, { actor: "owner", channel: "owner", action: "task.reopen", taskId: t.id, detail: input.reason ?? "" });
    return { taskId: t.id, status: "backlog" };
  });
}

/**
 * Owner 作废需求：这件事不做了。
 *
 * 为什么必须有这条路：parked 只能 reopen（重试），需求也没有终态。
 * 于是「做完发现不该做」「试了三次决定放弃」这两件很平常的事在产品里没有出口——
 * 需求永远占着覆盖率，Agent 的 next 永远在等一个不会发生的 reopen。
 * 作废是 Owner 的决定，所以只在控制台，不进 MCP。
 */
export function reqAbandon(db, root, input) {
  return tx(db, () => {
    const req = getReq(db, input.requirementId);
    if (!req) fail("NOT_FOUND", `需求不存在：${input.requirementId}`);
    if (req.status === "archived") fail("E_ILLEGAL_TRANSITION", `${req.id} 已经作废过了`);
    const reason = String(input.reason ?? "").trim();
    if (reason.length < 12) fail("E_CONTRACT", `作废要写理由（至少 12 字，现在 ${reason.length} 字）：以后才知道为什么没做`);
    // 连带把还挂着的任务一起归档：否则它们躺在 backlog 里，Agent 会一直想去领
    const live = listTasks(db).filter(
      (t) => t.requirement_id === req.id && ["backlog", "parked", "doing"].includes(t.status),
    );
    for (const t of live) {
      db.prepare(
        "UPDATE tasks SET status='abandoned', claimed_by=NULL, claim_expires_at=NULL, closing_token=NULL, archived_at=?, updated_at=? WHERE id=?",
      ).run(now(), now(), t.id);
    }
    db.prepare("UPDATE requirements SET status='archived', archived_at=? WHERE id=?").run(now(), req.id);
    logEvent(db, {
      actor: "owner",
      channel: "owner",
      action: "req.abandon",
      detail: `${req.id}${live.length ? ` 连带 ${live.map((t) => t.id).join(",")}` : ""}：${reason}`,
    });
    return { requirementId: req.id, status: "archived", archivedTasks: live.map((t) => t.id) };
  });
}

/**
 * Owner 调任务顺序。Backlog 的顺序就是优先级——Jira 也是这么干的，不另搞优先级标签。
 *
 * mode:
 *   "top"  置顶（排到所有 backlog 之前）
 *   "rank" 直接给一个数字（高级用法，比如排到某条之后）
 */
export function taskRank(db, input) {
  return tx(db, () => {
    const t = getTask(db, input.taskId);
    if (!t) fail("NOT_FOUND", `任务不存在：${input.taskId}`);
    if (!["backlog", "parked"].includes(t.status)) {
      fail("E_ILLEGAL_TRANSITION", `${t.id} 当前 ${t.status}，只有还没开工的任务才谈得上排序`);
    }
    let rank;
    if (input.mode === "top") {
      const min = db.prepare("SELECT COALESCE(MIN(rank), 0) m FROM tasks WHERE status='backlog'").get().m;
      rank = min - 1;
    } else if (Number.isFinite(Number(input.rank))) {
      rank = Number(input.rank);
    } else {
      fail("E_CONTRACT", "要么给 mode='top'，要么给一个数字 rank");
    }
    db.prepare("UPDATE tasks SET rank=?, updated_at=? WHERE id=?").run(rank, now(), t.id);
    logEvent(db, { actor: "owner", channel: "owner", action: "task.rank", taskId: t.id, detail: `rank=${rank}` });
    return { taskId: t.id, rank };
  });
}

export function bugDecide(db, input) {
  return tx(db, () => {
    const b = getBug(db, input.bugId);
    if (!b) fail("NOT_FOUND", `Bug 不存在：${input.bugId}`);
    const decision = String(input.decision ?? "accept");
    if (!["accept", "reject", "wontfix"].includes(decision)) fail("INVALID_ARGUMENT", `未知裁决：${decision}`);
    if (b.status !== "new") fail("E_ILLEGAL_TRANSITION", `${b.id} 已裁决（${b.status}）`);
    // 采纳 = 要修，进修复队列；驳回 / wontfix = 到此为止
    const status = decision === "accept" ? "fixing" : "closed";
    db.prepare("UPDATE bugs SET status=?, closed_by=? WHERE id=?").run(status, decision, b.id);
    logEvent(db, { actor: "owner", channel: "owner", action: "bug.decide", detail: `${b.id} ${decision} → ${status}` });
    return { bugId: b.id, status, decision };
  });
}

export function answer(db, input) {
  return tx(db, () => {
    const q = db.prepare("SELECT * FROM questions WHERE id=?").get(input.questionId);
    if (!q) fail("NOT_FOUND", `问题不存在：${input.questionId}`);
    db.prepare("UPDATE questions SET answer=?, answered_at=?, status='answered' WHERE id=?").run(String(input.answer ?? ""), now(), q.id);
    if (q.task_id) {
      db.prepare("UPDATE tasks SET status='backlog', claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL, updated_at=? WHERE id=? AND status='parked'").run(now(), q.task_id);
    }
    logEvent(db, { actor: "owner", channel: "owner", action: "answer", taskId: q.task_id, detail: q.id });
    return { questionId: q.id, taskResumed: q.task_id ?? null };
  });
}

export function override(db, input) {
  return tx(db, () => {
    const t = getTask(db, input.taskId);
    if (!t) fail("NOT_FOUND", `任务不存在：${input.taskId}`);
    const reason = String(input.reason ?? "").trim();
    // 12 字够写清"为什么放行"；门槛太高只会让人复制粘贴废话，反而丢了审计价值
    if (reason.length < 12) fail("E_CONTRACT", `放行理由至少 12 字（现在 ${reason.length} 字）：写清楚为什么这次可以放行，会进审计`);
    // 错误码只有 waive 才需要：force-close 是"整体签字收工"，不针对某一条门禁
    if (input.mode !== "force-close" && !input.code) fail("E_CONTRACT", "放行要指明拦下的是哪个错误码（例如 E_DEP_OR_TEST_TOUCH）");
    if (input.mode === "force-close") {
      db.prepare("UPDATE tasks SET status='done', closed_by='force-close', closed_at=?, closing_at=NULL, closing_token=NULL, updated_at=? WHERE id=?").run(now(), now(), t.id);
    } else {
      setWaive(db, t.id, input.code);
    }
    logEvent(db, { actor: "owner", channel: "owner", action: "override", taskId: t.id, code: input.code, detail: input.reason });
    return { taskId: t.id, mode: input.mode ?? "waive", code: input.code };
  });
}

/**
 * 释放任务：把「有人在办」退回「待办」。
 *
 * 为什么必须有这条：Agent 领了任务之后挂掉 / 失联 / 被换掉，它不会自己释放。
 * 原来只能干等 45 分钟租约过期——这期间同一个项目的其他 Agent 全被挡住，
 * 而且没有任何人能在控制台上把这件事解开。
 */
export function taskRelease(db, input) {
  return tx(db, () => {
    const t = getTask(db, input.taskId);
    if (!t) fail("NOT_FOUND", `任务不存在：${input.taskId}`);
    if (t.status !== "doing") fail("E_ILLEGAL_TRANSITION", `${t.id} 当前 ${t.status}，不是「有人在办」的状态`);
    const prev = t.claimed_by;
    db.prepare(
      "UPDATE tasks SET status='backlog', claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL, closing_token=NULL, claim_fingerprint=NULL, updated_at=? WHERE id=?",
    ).run(now(), t.id);
    logEvent(db, { actor: "owner", channel: "owner", action: "task.release", taskId: t.id, detail: `from ${prev ?? "?"}` });
    return { taskId: t.id, status: "backlog", releasedFrom: prev };
  });
}

/**
 * 这张任务已经干到哪了。
 *
 * 以前卡片写的是 changed_lines——那个字段只在收口时才写，于是在办任务永远显示「已用 0 行」。
 * 交接时给接手的人一条假进度，比不给更坏：他会以为这是从零开始的活。
 * 所以这里改从真账本取：带 Task-Id 的提交、它们的行数、以及最近一次被拦。
 */
function progressOf(db, root, t) {
  const out = [];
  let touched = null;
  if (root && t.base_head) {
    try {
      const mine = logCommits(root, `${t.base_head}..HEAD`).filter((c) => trailers(c.body, "Task-Id").includes(t.id));
      if (mine.length) {
        let lines = 0;
        touched = new Set();
        for (const c of mine) {
          for (const s of numstat(root, c.sha)) {
            lines += s.added + s.deleted;
            touched.add(s.file);
          }
        }
        out.push(`已提交 ${mine.length} 个（${lines} 行 / ${touched.size} 处文件）`);
      }
    } catch {
      // 弱模式或没有 git：进度说不准就别说
    }
  }
  // scope 覆盖度：申报的范围里，哪些还完全没碰过。
  // 这是内核数得出来的事实；「下一步该干什么」是判断，不归内核（见 T-077 那条分工线）。
  // 所以这里不让人填一句话，只把「还剩哪几处」摆出来。
  if (touched?.size) {
    const cold = (t.scope ?? []).filter((s) => ![...touched].some((f) => inScope(f, [s])));
    if (cold.length) out.push(`还有 ${cold.length} 处没碰：${cold.join("、")}`);
  }
  const lastFail = db.prepare("SELECT code, detail FROM events WHERE task_id=? AND action='close.fail' ORDER BY id DESC LIMIT 1").get(t.id);
  if (lastFail) out.push(`上次被拦 ${lastFail.code}（${lastFail.detail}）`);
  if (!out.length) out.push("还没有提交，从头做");
  return out;
}

export function handoff(db, input, root = null) {
  const t = getTask(db, input.taskId);
  if (!t) fail("NOT_FOUND", `任务不存在：${input.taskId}`);
  // 交接 = 释放 + 卡片。只给卡片不释放，等于让人拿着票根去坐一张还被人占着的车：
  // 另一个 Agent 拿到卡片第一句 task.claim 就会被 E_CLAIMED_BY_OTHER 挡住。
  const released = t.status === "doing" ? taskRelease(db, { taskId: t.id }) : null;
  const req = getReq(db, t.requirement_id);
  const p = getPath(db, t.path_id);
  const lines = [
    `【${t.id}】${t.title}`,
    `需求 ${req?.id ?? "?"} · Path ${p?.id ?? "?"} · scope: ${t.scope.join(", ") || "(未设)"}`,
    `验收: ${t.acceptance.map((a) => a.assertion).join("；") || "(未设)"}`,
    `前置: ${t.dependsOn.length ? t.dependsOn.join(", ") : "无"} · 预算: ${t.budget_lines} 行`,
    `进度: ${progressOf(db, root, t).join(" · ")}`,
    released ? "（已释放：下面这张卡拿给谁，谁就能接）" : "",
    `起步: devcontrol mcp → task.claim(${t.id})`,
  ].filter(Boolean);
  return { text: lines.join("\n"), released };
}