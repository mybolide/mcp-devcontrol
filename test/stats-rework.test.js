// devcontrol — 「返工」到底数的是什么。
//
// 起因（T-116）：在 crm-suite 里真跑了一轮，T-004 的测试红过一次、改好又绿了，
// 但 `devcontrol stats` 报「返工 0 轮」——因为返工只数 review_round（门禁拒绝）。
// 最典型的返工反而看不见，指标等于在替 Agent 遮丑。
//
// 现在的口径：同一条 exit≠0 的证据，只要同一任务之后还有一次 exit==0，就记一轮；
// 再加上门禁那笔 review_round。最后一次仍是失败的不算——那不是返工，是还没成。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { countRework, disciplineStats } from "../src/store.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { weekly, verdict } from "../src/weekly.js";
import { BIN, makeRepo, initFlow, newTask, closeProven, prove } from "./helpers.js";

function insertRun(db, { id, taskId, exit, at }) {
  db.prepare(
    `INSERT INTO runs(id, task_id, assertion_idx, command, exit_code, head,
       fingerprint, log_sha256, output, started_at, duration_ms)
     VALUES(?,?,0,'npm test',?,'h','f','sha','',?,1)`,
  ).run(id, taskId, exit, at);
}

const T = (m) => `2026-04-01T10:0${m}:00.000Z`;

test("空库：返工是 0", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  assert.equal(countRework(db), 0);
});

test("跑挂一次、之后跑过了：算一轮", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  insertRun(db, { id: "run-a", taskId: t.id, exit: 1, at: T(1) });
  insertRun(db, { id: "run-b", taskId: t.id, exit: 0, at: T(2) });
  assert.equal(countRework(db), 1);
});

test("连挂两次才通过：两轮（这就是「反复做」）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  insertRun(db, { id: "run-a", taskId: t.id, exit: 1, at: T(1) });
  insertRun(db, { id: "run-b", taskId: t.id, exit: 1, at: T(2) });
  insertRun(db, { id: "run-c", taskId: t.id, exit: 0, at: T(3) });
  assert.equal(countRework(db), 2);
});

test("只挂过、还没通过：不算返工（那是还没成，不是重来）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  insertRun(db, { id: "run-a", taskId: t.id, exit: 1, at: T(1) });
  assert.equal(countRework(db), 0, "还在失败中，不能算成已返工");
});

test("先过再挂：后面的失败没有「之后的通过」，不算", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  insertRun(db, { id: "run-a", taskId: t.id, exit: 0, at: T(1) });
  insertRun(db, { id: "run-b", taskId: t.id, exit: 1, at: T(2) });
  assert.equal(countRework(db), 0);
});

test("同一毫秒内的两条按插入顺序定先后，不当成「同时」", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  const same = T(1);
  insertRun(db, { id: "run-a", taskId: t.id, exit: 1, at: same });
  insertRun(db, { id: "run-b", taskId: t.id, exit: 0, at: same });
  assert.equal(countRework(db), 1);
});

test("不同任务互不串账", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const a = newTask(db, root, reqId, { title: "a" });
  const b = newTask(db, root, reqId, { title: "b" });
  // a 挂了、b 过了：a 没有「之后的通过」，不能借 b 的绿
  insertRun(db, { id: "run-a", taskId: a.id, exit: 1, at: T(1) });
  insertRun(db, { id: "run-b", taskId: b.id, exit: 0, at: T(2) });
  assert.equal(countRework(db), 0);
});

test("按时间窗只数窗内的失败证据", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  insertRun(db, { id: "run-a", taskId: t.id, exit: 1, at: "2026-03-01T00:00:00.000Z" });
  insertRun(db, { id: "run-b", taskId: t.id, exit: 0, at: "2026-03-02T00:00:00.000Z" });
  assert.equal(countRework(db), 1);
  assert.equal(
    countRework(db, { since: "2026-03-15T00:00:00.000Z" }),
    0,
    "窗在失败之后，就不该再算它",
  );
  assert.equal(countRework(db, { since: "2026-02-01T00:00:00.000Z" }), 1);
});

test("disciplineStats：门禁那笔 + 证据那笔，两笔都算", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");

  assert.equal(disciplineStats(db).rework, 0);

  // 第一笔：Agent 自己跑挂了，改好又跑过
  prove(db, root, t.id, { exit: 1 });
  prove(db, root, t.id, { exit: 0 });
  assert.equal(disciplineStats(db).rework, 1, "跑挂一次再修好，得记一轮");

  // 第二笔：门禁拒绝（证据不满足验收）→ review_round
  await assert.rejects(
    () => taskClose(db, root, { id: t.id }, "agentA").then((r) => r),
    () => true,
  );
});

test("disciplineStats：只有门禁拒绝时，返工来自 review_round（行为没变）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");

  // 没有任何失败证据，先收口一次必然被拒（缺证据）
  await assert.rejects(() => closeProven(db, root, { id: t.id }, { exit: 1 }));
  assert.equal(db.prepare("SELECT review_round AS r FROM tasks WHERE id=?").get(t.id).r, 0, "证据不满足验收不算门禁返工");
  assert.equal(disciplineStats(db).rework, 0);
});

// —— 真机那条路：CLI 跑挂、跑过，再看 stats / 周报怎么说 ——
function run(root, args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("CLI 端到端：run 挂了再跑过，stats 和周报都得说出「返工 1 轮」", () => {
  const root = makeRepo({ failTest: true });
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  assert.equal(run(root, ["task", "claim", t.id]).code, 0);

  const failed = run(root, ["run", "--", "npm", "test"]);
  assert.equal(failed.code, 1, "这条命令本来就该失败");

  // 把测试改成通过，再跑一次——等价于 Agent 改完代码重跑
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "d", version: "1.0.0", scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  const passed = run(root, ["run", "--", "npm", "test"]);
  assert.equal(passed.code, 0);

  const stats = run(root, ["stats"]);
  assert.equal(stats.code, 0);
  assert.match(stats.stdout, /返工 1 轮/, `stats 该说返工 1 轮：${stats.stdout}`);

  const w = weekly(db, { days: 7, now: new Date(Date.now() + 1000) });
  assert.equal(w.totals.reworks, 1);
  assert.match(verdict(w), /返工 1 轮/, "周报的结论行也要说");
});