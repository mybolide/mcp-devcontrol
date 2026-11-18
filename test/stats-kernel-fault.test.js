// devcontrol — 内核自己的故障，账不能记在 Agent 头上。
//
// 起因（T-119）：T-012 收口时内核自己崩了（close 门禁引用了未定义的 fakeApprove），
// 那条 E_INTERNAL 被当成 Agent 被拦了两次，review_round 涨到 2——再崩一次就直接挂起。
// 那是 Agent 手里解不开的东西：它既不知道内核为什么崩，也没法改内核。
//
// 同一轮里还发现第二个洞：「返工」读的是 tasks.review_round，而 taskReopen 会把它清零，
// 于是打回重做一次，历史上的返工凭空蒸发。事件是不可变的，数事件才对。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { disciplineStats, classifyRejections, countGateRounds, FAULT_CODES, ENV_ONLY_CODES } from "../src/store.js";
import { weekly, verdict } from "../src/weekly.js";
import { taskClaim, taskClose, recordEvidence } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import { taskReopen } from "../src/store.js";
import { BIN, makeRepo, initFlow, newTask, prove } from "./helpers.js";

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

function seed(db, rows) {
  const stmt = db.prepare("INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)");
  for (const [at, action, code, detail] of rows) {
    stmt.run(at, "agent-a", "agent", action, "T-001", code, detail);
  }
}

const NOW = new Date("2026-03-10T12:00:00.000Z");

test("E_INTERNAL 是内核的锅：不进被拦，也不进「补一步就好」", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    ["2026-03-05T10:00:00.000Z", "close.fail", "E_INTERNAL", "第 1 次"],
    ["2026-03-05T10:01:00.000Z", "rejected", "E_INTERNAL", ""],
    ["2026-03-05T10:02:00.000Z", "rejected", "E_SCOPE_VIOLATION", ""],
  ]);

  const s = disciplineStats(db);
  assert.equal(s.blocked, 1, "只有真越界算被拦");
  assert.equal(s.faults, 2, "内核自己崩了两次，单独记，不许装作没发生");
  assert.equal(s.envOnly, 0, "它不是「补一步就好」——Agent 补不了");
});
test("内核真的崩了：事件照记，但不给 Agent 加轮次（T-012 那种账）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/a.js"] });
  taskClaim(db, root, { id: t.id }, "agentA");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${t.id}`, { author: "agentA" });
  prove(db, root, t.id);

  // 把 scope_json 弄成非数组，close 里 `for (const s of scope)` 会抛 TypeError——
  // 这不是 DFError，没有 code，门禁走兜底记成 E_INTERNAL。等价于内核自己写崩了。
  db.prepare("UPDATE tasks SET scope_json=? WHERE id=?").run("{}", t.id);

  await assert.rejects(() => taskClose(db, root, { id: t.id }));
  assert.equal(
    db.prepare("SELECT review_round FROM tasks WHERE id=?").get(t.id).review_round,
    0,
    "内核的 bug 不该给 Agent 记轮次——攒三次就挂起，它解不开",
  );
  const ev = db.prepare("SELECT code, detail FROM events WHERE task_id=? AND action='close.fail'").all(t.id);
  assert.equal(ev.length, 1, "事件还得记：内核崩了要看得见");
  assert.equal(ev[0].code, "E_INTERNAL");
  assert.match(ev[0].detail, /内核自身故障/);
  assert.equal(countGateRounds(db), 0, "所以它也不进返工");
});

test("返工从事件流数：reopen 清零了 review_round，历史也不能蒸发", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/a.js"] });
  taskClaim(db, root, { id: t.id }, "agentA");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${t.id}`, { author: "agentA" });

  // ① 收口被拒一次 → review_round 1，事件流 1 条 close.fail
  prove(db, root, t.id, { exit: 1 });
  await assert.rejects(() => taskClose(db, root, { id: t.id }), (e) => e.code === "E_ASSERTION_FAILED");
  assert.equal(countGateRounds(db), 1, "门禁拒了一次");

  // ② 改好之后正常收口（失败过就得写 resolvedBy）
  prove(db, root, t.id);
  await taskClose(db, root, { id: t.id, resolvedBy: "补上边界情况后重跑，验收通过" });

  // ③ Owner 打回重做：tasks.review_round 被清零
  taskReopen(db, { taskId: t.id, reason: "这条其实没做完，打回重做，请补上边界情况" });
  assert.equal(db.prepare("SELECT review_round FROM tasks WHERE id=?").get(t.id).review_round, 0, "字段确实被清零");

  assert.equal(countGateRounds(db), 1, "但事件不会消失：门禁那一轮还在，历史没被抹掉");
});

test("门禁轮次按时间窗切，周报和 stats 用同一把尺子", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    ["2026-03-04T10:00:00.000Z", "close.fail", "E_SCOPE_VIOLATION", "第 1 次"],
    ["2026-03-05T10:00:00.000Z", "close.fail", "E_DIFF_BUDGET", "第 1 次"],
    ["2026-03-05T10:01:00.000Z", "close.fail", "E_NO_EVIDENCE", "第 1 次"], // 补一步就好，不算
    ["2026-03-05T10:02:00.000Z", "close.fail", "E_INTERNAL", "内核故障"], // 不算
  ]);

  assert.equal(countGateRounds(db), 2, "只数真正记到 Agent 账上的");
  assert.equal(countGateRounds(db, { since: "2026-03-05T00:00:00.000Z" }), 1, "时间窗切得动");

  const w = weekly(db, { days: 7, now: NOW });
  assert.equal(w.totals.reworks, 2, "周报的门禁轮次跟 stats 一致");
  assert.equal(w.totals.faults, 1, "内核故障单独摊出来");
  assert.equal(w.totals.envOnly, 1);
  assert.equal(w.totals.blocked, 2);
});

test("结论行说清「内核自身故障」，且明说不是 Agent 的账", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    ["2026-03-05T09:00:00.000Z", "close", null, ""],
    ["2026-03-05T10:00:00.000Z", "close.fail", "E_INTERNAL", "内核故障"],
  ]);

  const line = verdict(weekly(db, { days: 7, now: NOW }));
  assert.match(line, /内核自身故障 1 次/, `得说出来：${line}`);
  assert.match(line, /不算你的账/, `还得说清归属：${line}`);
  assert.doesNotMatch(line, /被拦 1 次/, "不能算成 Agent 被拦");
});

test("stats 的 CLI 文案也把内核故障单列", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [["2026-03-05T10:00:00.000Z", "close.fail", "E_INTERNAL", "内核故障"]]);
  void db;

  const out = run(root, ["stats"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /被拦 0 次/, `内核崩了不算 Agent 被拦：${out.stdout}`);
  assert.match(out.stdout, /内核自身故障 1 次/, `但要说出来：${out.stdout}`);
});

test("两份名单不重叠：一个 code 不能既是内核故障、又是补一步就好", () => {
  for (const code of FAULT_CODES) {
    assert.ok(!ENV_ONLY_CODES.has(code), `${code} 同时出现在两份名单里，判据会含糊`);
  }
  assert.ok(FAULT_CODES.has("E_INTERNAL"), "兜底码必须在故障名单里");
  // 真违规当然两边都不在
  for (const code of ["E_SCOPE_VIOLATION", "E_DIFF_BUDGET", "E_UNOWNED_COMMIT"]) {
    assert.ok(!FAULT_CODES.has(code) && !ENV_ONLY_CODES.has(code), `${code} 是真违规`);
  }
});

test("分类顺序对：先认内核故障，再认补一步就好，剩下的才算被拦", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    ["2026-03-05T10:00:00.000Z", "rejected", "E_INTERNAL", ""],
    ["2026-03-05T10:01:00.000Z", "rejected", "E_USAGE", ""],
    ["2026-03-05T10:02:00.000Z", "rejected", "E_SCOPE_VIOLATION", ""],
  ]);
  assert.deepEqual(classifyRejections(db), { blocked: 1, envOnly: 1, faults: 1 });
});