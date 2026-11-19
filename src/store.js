// devcontrol — 存储与 Owner 侧动作
import fs from "node:fs";
import path from "node:path";
import { logEvent, metaGet, metaSet, nextId, tx } from "./db.js";
import { commitContract, contractBody, parseAssertion, readContract } from "./contract.js";
import { inScope } from "./fingerprint.js";
import { logCommits, numstat, trailers } from "./git.js";
import { sha256 } from "./fingerprint.js";
import { assertionCommand, detectTestCmds, retargetAssertion } from "./testcmd.js";
import { assertScopeInsideRepo, assertScopeIsSpecific } from "./scope.js";

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
 * 「返工」的另一半：同一任务上，一条 exit≠0 的证据之后又跑过了，记一轮。
 *
 * 早先返工只数 review_round（门禁拒绝），于是「测试红了 → 改 → 绿了」这一整轮
 * 在指标里完全看不见——那恰恰是最典型的返工（T-116）。内核不跑测试，但 Agent
 * 留下的每条证据都带退出码，数得清就不该装作没看见。
 *
 * 边界：最后一次尝试仍是失败（还没通过）的不算——那不是返工，是还没成。
 */
export function countRework(db, { since = null, until = null } = {}) {
  const where = ["r.exit_code <> 0"];
  const params = [];
  if (since) {
    where.push("r.started_at >= ?");
    params.push(since);
  }
  if (until) {
    where.push("r.started_at <= ?");
    params.push(until);
  }
  // 先后用 started_at 定，同一毫秒内的两条再按 rowid 排——不能把「同时」当成「之后」
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM runs r
        WHERE ${where.join(" AND ")}
          AND EXISTS (
            SELECT 1 FROM runs p
             WHERE p.task_id = r.task_id
               AND p.exit_code = 0
               AND (p.started_at > r.started_at
                    OR (p.started_at = r.started_at AND p.rowid > r.rowid)))`,
    )
    .get(...params);
  return row.c;
}
/**
 * 哪些拒绝算「补一步就好」，不算纪律问题。
 *
 * 三类：
 * ① 证据/环境类——忘了跑测试、工作树脏、超时（本来就不该算 Agent 的账）；
 * ② 用法类——命令拼错、参数不认识（T-117：这是打字问题，不是纪律问题）；
 * ③ 没找到东西——编号不存在（同上，找错了不等于越界）。
 *
 * 判据是「补一步就能好、没有任何信息量可学」：这类数进「被拦」只会让指标虚高，
 * 而指标的唯一用途是看内核到底拦住了什么真问题。
 *
 * 唯一事实源：gates.js 判 review_round 时也用这一份（T-117 之前是两处各写一遍，
 * 谁改漏一处就会出现「stats 说没拦、review_round 却涨了」这种自相矛盾）。
 */
export const ENV_ONLY_CODES = new Set([
  // ① 证据 / 环境
  "E_DIRTY_SCOPE",
  "E_BUSY",
  "E_TIMEOUT",
  "E_NO_EVIDENCE",
  "E_EVIDENCE_STALE",
  "E_NO_DELIVERY",
  // ② 用法
  "E_USAGE",
  "INVALID_ARGUMENT",
  // ③ 找错了
  "NOT_FOUND",
]);

/**
 * 哪些 code 说明「内核自己出了问题」，跟 Agent 干的活没关系。
 *
 * `E_INTERNAL` 是兜底：某处 `throw` 出来的 error 没有 code，或者内核自己写崩了。
 * 把它算进「被拦」，等于内核的 bug 变成 Agent 的业绩；更糟的是它还会让
 * `review_round` 涨——攒到三次直接把任务挂起，Agent 拿一个自己碰不到的东西
 * 永远解不开（T-012 的两轮返工就是这么记的）。
 *
 * 归属很清楚：内核的故障该被上报、被发现，但账不记在干活的人头上。
 * 和 `ENV_ONLY_CODES` 分开放，因为含义不同：那是「补一步就好」，这是「不是你的错」。
 */
export const FAULT_CODES = new Set(["E_INTERNAL"]);

/**
 * 一次拒绝算不算「被拦」——按 code 现算，不看写入时记下的结论。
 *
 * T-118：早先把分类结果（`detail='env-only'`）在写事件那一刻就固化下来，于是
 * 规则一改，历史行永远不认账——crm-suite 上把名单改对了、stats 照样说「被拦 3 次」。
 * 事件的 `code` 是事实，分类是解释；解释会演进，事实不会，所以解释必须每次重算。
 * `rejected` 和 `close.fail` 用同一条判据：门禁里判 `review_round` 用的也是它。
 */
export function classifyRejections(db, { since = null, until = null } = {}) {
  const where = ["action IN ('rejected','close.fail')"];
  const params = [];
  if (since) {
    where.push("at >= ?");
    params.push(since);
  }
  if (until) {
    where.push("at <= ?");
    params.push(until);
  }
  const rows = db
    .prepare(`SELECT code, COUNT(*) AS c FROM events WHERE ${where.join(" AND ")} GROUP BY code`)
    .all(...params);
  let blocked = 0;
  let envOnly = 0;
  let faults = 0;
  for (const r of rows) {
    // 判据顺序有意义：先认「内核自己的锅」，再认「补一步就好」，剩下的才算被拦。
    // 把 FAULT 放进 ENV_ONLY 会丢掉「这是内核 bug」这个信息，反过来则会把它算成 Agent 的账。
    if (FAULT_CODES.has(r.code)) faults += r.c;
    else if (ENV_ONLY_CODES.has(r.code)) envOnly += r.c;
    else blocked += r.c;
  }
  return { blocked, envOnly, faults };
}

/**
 * 记一次拒绝。CLI 和 MCP 都走这里，否则「被拦」只算得到一半路径上的事。
 * 记账失败不能把错误提示也弄丢，所以调用方一律用 try 包住。
 */
export function logRejection(db, actor, code) {
  // detail 不再写分类结论：那是「写入时的解释」，统计时会被当成事实用，两套口径就此分家（T-118）。
  // code 就是全部事实，怎么归类由 classifyRejections 在读取时现算。
  logEvent(db, { actor: actor || "agent", action: "rejected", code });
}

/**
 * 门禁拒了几轮 —— 从事件流数，不读 tasks.review_round。
 *
 * 为什么不读那个字段：`taskReopen` 会把它清零（打回重做等于重新开始），
 * 于是「返工」这个数只要被 reopen 一次就凭空少几轮，历史被抹掉。
 * 事件是不可变的，数它才数得准，也能按时间窗切。
 *
 * 只数真正记到 Agent 账上的（排除补一步就好与内核自身故障），与门禁加轮的判据一致。
 */
export function countGateRounds(db, { since = null, until = null } = {}) {
  const where = ["action = 'close.fail'"];
  const params = [];
  if (since) {
    where.push("at >= ?");
    params.push(since);
  }
  if (until) {
    where.push("at <= ?");
    params.push(until);
  }
  const rows = db.prepare(`SELECT code, COUNT(*) AS c FROM events WHERE ${where.join(" AND ")} GROUP BY code`).all(...params);
  let n = 0;
  for (const r of rows) {
    if (!ENV_ONLY_CODES.has(r.code) && !FAULT_CODES.has(r.code)) n += r.c;
  }
  return n;
}

/**
 * 纪律三数：被拦多少次、返工多少轮、绕过多少次。外加已完成多少任务。
 *
 * 这是「内核到底有没有生效」的可核对证据，不靠人回忆。
 *
 * `since` / `until` 不是可选项里的装饰：周报按窗口算「收口几条」，
 * 这里不认窗口就必然对不上（stats 说全时 125、周报说本周 38），
 * 「同一个词两个数」的账就会一直挂着（T-127）。
 * 传了窗口，两者就能逐字相等；不传就是全时——那是另一个问题，措辞要说清。
 */
export function disciplineStats(db, { since = null, until = null } = {}) {
  // 「被拦」= 所有实质拒绝 + 收口失败（T-097）。早先只数 close.fail，指标恒为 0；
  // 现在按 code 现算分类，名单改了历史行也跟着重算（T-118）。
  const { blocked, envOnly, faults } = classifyRejections(db, { since, until });
  // 「返工」= 两笔账：① 门禁拒了几轮（从事件流数，reopen 抹不掉）
  // ② 真跑挂过的证据之后又跑过了（T-116：Agent 自己测试红了再修好，这才最该被看见）
  const rework = countGateRounds(db, { since, until }) + countRework(db, { since, until });
  const bypassed = countEvents(db, "action='override'", since, until);
  // 「已完成」数的是任务现状（status='done'）。给了窗口就按 closed_at 切，
  // 和周报的「收口」用同一个判据、同一段时间——两边必须能对上。
  const done = since || until
    ? db
        .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status='done'${since ? " AND closed_at >= ?" : ""}${until ? " AND closed_at <= ?" : ""}`)
        .get(...[since, until].filter(Boolean)).c
    : db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status='done'").get().c;
  return { blocked, envOnly, faults, rework, bypassed, done };
}

/** 按条件数事件：三个计数都走它，保证窗口过滤只有一套写法。 */
function countEvents(db, condition, since, until) {
  const where = [condition];
  const params = [];
  if (since) {
    where.push("at >= ?");
    params.push(since);
  }
  if (until) {
    where.push("at <= ?");
    params.push(until);
  }
  return db.prepare(`SELECT COUNT(*) AS c FROM events WHERE ${where.join(" AND ")}`).get(...params).c;
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
    // 从哪个入口来的：控制台是人点的（owner），终端是 Owner 自己敲的（cli）。
    // 两个都要能看见——不然「谁批准了这条需求」在 CLI 模式下永远写 owner，
    // 等于把 Agent 自己批准自己的可能洗白了（T-104）。
    const via = input.channel === "cli" ? "（终端）" : "";
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
    logEvent(db, { actor: "owner", channel: input.channel ?? "owner", action: "req.intake", detail: `${input.title ?? ""}${via}` });
    return { id, type };
  });
}

/** 一键批准：需求 + Path 一起冻结，写契约提交 */
export function reqApprove(db, root, input) {
  return tx(db, () => {
    const via = input.channel === "cli" ? "（终端）" : "";
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
    logEvent(db, { actor: "owner", channel: input.channel ?? "owner", action: "req.approve", detail: `${req.id} + ${p.id} @ ${sha ? sha.slice(0, 8) : "弱模式"}${via}` });
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
    // Owner 放宽 scope 也要守同一道边界：否则 Agent 求 Owner「把 /tmp/x 加进 scope」，
    // 这条路一样能把仓库外的文件变成「内核批准过」的（T-124）。
    assertScopeInsideRepo(scope);
    // Owner 放宽 scope 也不能放宽到「整个仓库」：否则 Agent 只要说服 Owner 写一个 `.`，
    // 就绕过了 task.create 那道门（T-130）。两个入口守同一条边界。
    assertScopeIsSpecific(scope);
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
      // 同一个时刻写 closed_at 和 override 事件：两处各调一次 now() 会让
      // 「按 closed_at 归天」与「按事件归天」差几毫秒，窗口边界上就分家（T-127）。
      const closedAt = now();
      db.prepare("UPDATE tasks SET status='done', closed_by='force-close', closed_at=?, closing_at=NULL, closing_token=NULL, updated_at=? WHERE id=?").run(closedAt, closedAt, t.id);
      logEvent(db, { actor: "owner", channel: "owner", action: "override", taskId: t.id, code: input.code, at: closedAt, detail: input.reason });
      return { taskId: t.id, mode: input.mode, code: input.code };
    }
    setWaive(db, t.id, input.code);
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