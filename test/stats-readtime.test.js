// devcontrol — 「被拦」的分类必须在读取时现算，不能信写入时固化下来的结论。
//
// 起因（T-118）：crm-suite 上把名单改对了，stats 照样说「被拦 3 次」。
// 因为 events.detail 在写事件那一刻就把分类结果写死了，规则演进对历史行无效——
// 而那正是「这个数字到底可不可信」的最后一环。
//
// 这条原则比某一版名单更重要：code 是事实，分类是解释。解释会变，事实不会。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { disciplineStats, classifyRejections, ENV_ONLY_CODES } from "../src/store.js";
import { weekly, verdict } from "../src/weekly.js";
import { BIN, makeRepo, initFlow } from "./helpers.js";

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

/** 直接写事件行：模拟「历史数据」，detail 就是当年写下的结论 */
function seed(db, rows) {
  const stmt = db.prepare(
    "INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)",
  );
  for (const [at, action, code, detail] of rows) {
    stmt.run(at, "agent-old", "agent", action, "T-001", code, detail);
  }
}

const NOW = new Date("2026-03-10T12:00:00.000Z");

test("历史行 detail 是空的，照样能按 code 认出「补一步就好」", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  // 这正是 crm-suite 里那批行：规则改了，detail 还是空的
  seed(db, [
    ["2026-03-05T10:00:00.000Z", "rejected", "E_USAGE", ""],
    ["2026-03-05T10:01:00.000Z", "rejected", "NOT_FOUND", ""],
    ["2026-03-05T10:02:00.000Z", "rejected", "E_SCOPE_VIOLATION", ""],
  ]);

  const s = disciplineStats(db);
  assert.deepEqual({ blocked: s.blocked, envOnly: s.envOnly }, { blocked: 1, envOnly: 2 }, "现算才认得出来");
});

test("历史行 detail 写错了（旧规则判的），以 code 为准", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    // 旧版本把 E_USAGE 当成真违规，写下了 detail=""；
    // 也可能反过来：某条真违规被错标成 env-only
    ["2026-03-05T10:00:00.000Z", "rejected", "E_USAGE", ""],
    ["2026-03-05T10:01:00.000Z", "rejected", "E_FILE_OVERLAP", "env-only"],
  ]);

  const s = disciplineStats(db);
  assert.equal(s.blocked, 1, "真撞车必须算被拦，哪怕 detail 说它不是");
  assert.equal(s.envOnly, 1, "打错命令不该算被拦，哪怕 detail 没说");
});

test("close.fail 和 rejected 同一把尺子：收口时的补一步就好也不算被拦", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  // E_NO_DELIVERY / E_NO_EVIDENCE 都是「还没做，补一步」。早先 close.fail 无条件算被拦，
  // 于是同一类事走 commit 不算、走 close 就算——两处口径不一样，数字谁都不信（T-118）。
  seed(db, [
    ["2026-03-05T10:00:00.000Z", "close.fail", "E_NO_DELIVERY", "第 1 次"],
    ["2026-03-05T10:01:00.000Z", "close.fail", "E_NO_EVIDENCE", "第 1 次"],
    ["2026-03-05T10:02:00.000Z", "close.fail", "E_SCOPE_VIOLATION", "第 1 次"],
  ]);

  const s = disciplineStats(db);
  assert.deepEqual({ blocked: s.blocked, envOnly: s.envOnly }, { blocked: 1, envOnly: 2 });

  const w = weekly(db, { days: 7, now: NOW });
  assert.equal(w.totals.blocked, 1, "周报跟 stats 必须同口径");
  assert.equal(w.totals.envOnly, 2, "补一步就好的也如实摊开，不许装作没发生");
  assert.deepEqual(w.topBlocked, [{ code: "E_SCOPE_VIOLATION", count: 1 }]);
});

test("周报也按 code 现算：detail 说不是被拦、code 说是，就按 code", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    ["2026-03-05T10:00:00.000Z", "rejected", "E_FILE_OVERLAP", "env-only"],
    ["2026-03-05T10:01:00.000Z", "rejected", "E_USAGE", ""],
  ]);

  const w = weekly(db, { days: 7, now: NOW });
  assert.equal(w.totals.blocked, 1, "真撞车不能因为一行旧 detail 就消失");
  assert.equal(w.totals.envOnly, 1);
  assert.deepEqual(w.topBlocked, [{ code: "E_FILE_OVERLAP", count: 1 }]);
});

test("名单只有一处：classifyRejections 用的就是 ENV_ONLY_CODES 这一份", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const codes = ["E_USAGE", "NOT_FOUND", "E_SCOPE_VIOLATION", "E_INHERITED_CHANGE"];
  seed(db, codes.map((c, i) => [`2026-03-05T10:0${i}:00.000Z`, "rejected", c, ""]));

  const expected = codes.filter((c) => ENV_ONLY_CODES.has(c)).length;
  const got = classifyRejections(db);
  assert.equal(got.envOnly, expected, "名单里有多少条，现算就该认出多少条");
  assert.equal(got.blocked, codes.length - expected);
});

test("stats 上的人读文案对得上现算的数（历史行也认）", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    ["2026-03-05T10:00:00.000Z", "rejected", "E_USAGE", ""],
    ["2026-03-05T10:01:00.000Z", "rejected", "NOT_FOUND", ""],
  ]);
  void db;

  const out = run(root, ["stats"]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /被拦 0 次/, `历史行也得认：${out.stdout}`);
  assert.match(out.stdout, /另有 2 次用法\/环境类/);
});

test("写入时不再往 detail 里塞分类结论（那正是漂移的源头）", () => {
  const src = fs.readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export function logRejection"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.doesNotMatch(body, /detail:\s*ENV_ONLY_CODES/, "logRejection 不许再把分类结果写死进 detail");
  assert.match(body, /action:\s*"rejected",\s*code/, "只记事实：code");
});

test("周报的 SQL 不再靠 detail 过滤（写了也别信）", () => {
  const src = fs.readFileSync(new URL("../src/weekly.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /detail\s*!==\s*"env-only"/, "按 detail 过滤的老写法必须绝迹");
  assert.match(src, /ENV_ONLY_CODES\.has\(e\.code\)/, "分类要在读取时按 code 现算");
});

test("结论行也把「补一步就好」说出来，不装成没发生", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  seed(db, [
    ["2026-03-05T09:00:00.000Z", "close", null, ""],
    ["2026-03-05T10:00:00.000Z", "rejected", "E_USAGE", ""],
    ["2026-03-06T10:00:00.000Z", "rejected", "E_SCOPE_VIOLATION", ""],
  ]);

  const line = verdict(weekly(db, { days: 7, now: NOW }));
  assert.match(line, /被拦 1 次/, `只有真越界算被拦：${line}`);
  assert.match(line, /另有 1 次补一步就好/, `打错命令也要说出来，但不能算进被拦：${line}`);
});
