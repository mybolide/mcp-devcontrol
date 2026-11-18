// devcontrol — 「被拦」只数真被拦住的纪律问题。
//
// 起因（T-117）：在 crm-suite 上跑完一轮，stats 说「被拦 3 次」，但其中两次是
// 我自己命令打错（E_USAGE）和发布号写错（NOT_FOUND）。把它们算进「被拦」，
// 等于把「打错字」说成「内核抓住了问题」——指标看起来漂亮，实际是虚的。
//
// 同时收掉一个隐患：gates.js 里曾经自己抄过一份同样的名单，两处一漏就会
// 出现「stats 说没拦，review_round 却涨了」的自相矛盾。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { disciplineStats, ENV_ONLY_CODES } from "../src/store.js";
import { weekly } from "../src/weekly.js";
import { taskClaim } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import { BIN, makeRepo, initFlow, newTask, closeProven } from "./helpers.js";

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

test("名单里得有这三类，也不能有真违规的码", () => {
  for (const code of ["E_USAGE", "INVALID_ARGUMENT", "NOT_FOUND"]) {
    assert.ok(ENV_ONLY_CODES.has(code), `${code} 属于「补一步就好」`);
  }
  for (const code of ["E_SCOPE_VIOLATION", "E_INHERITED_CHANGE", "E_FILE_OVERLAP", "E_UNOWNED_COMMIT"]) {
    assert.ok(!ENV_ONLY_CODES.has(code), `${code} 是真违规，不能被稀释`);
  }
});

test("命令打错（E_USAGE）：不进被拦，进「补一步就好」", () => {
  const root = makeRepo();
  const { db } = initFlow(root);

  const bad = run(root, ["release", "plan"]); // 没有发布号
  assert.equal(bad.code, 2);

  const s = disciplineStats(db);
  assert.equal(s.blocked, 0, "打错命令不是纪律问题");
  assert.equal(s.envOnly, 1, "但要如实记账，不能装作没发生");
});

test("编号找不到（NOT_FOUND）：同样不进被拦", () => {
  const root = makeRepo();
  const { db } = initFlow(root);

  const bad = run(root, ["evidence", "run-nope"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /NOT_FOUND/);

  const s = disciplineStats(db);
  assert.equal(s.blocked, 0);
  assert.equal(s.envOnly, 1);
});

test("真违规照样算被拦：scope 外的改动一次不少", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");

  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");
  fs.writeFileSync(path.join(root, "outside.js"), "export const o = 1;\n");
  commitFiles(root, ["src/a.js", "outside.js"], `feat\n\nTask-Id: ${t.id}`, { author: "agentA" });
  await assert.rejects(() => closeProven(db, root, { id: t.id }));

  const s = disciplineStats(db);
  assert.equal(s.blocked, 1, "改到 scope 外面必须记一笔");
  assert.equal(s.envOnly, 0, "这不是「补一步就好」");
});

test("用法错与真违规混在一起时，两个数各归各的", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agentA");

  run(root, ["release", "plan"]); // E_USAGE
  run(root, ["evidence", "run-nope"]); // NOT_FOUND
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 3;\n");
  fs.writeFileSync(path.join(root, "outside.js"), "export const o = 2;\n");
  commitFiles(root, ["src/a.js", "outside.js"], `feat\n\nTask-Id: ${t.id}`, { author: "agentA" });
  await assert.rejects(() => closeProven(db, root, { id: t.id }));

  const s = disciplineStats(db);
  assert.deepEqual(
    { blocked: s.blocked, envOnly: s.envOnly },
    { blocked: 1, envOnly: 2 },
    "被拦只该是那一次真越界",
  );
});

test("stats 的人读那一行说清「另外那些不算被拦」", () => {
  const root = makeRepo();
  initFlow(root);
  run(root, ["release", "plan"]);

  const out = run(root, ["stats"]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /被拦 0 次/);
  assert.match(out.stdout, /另有 1 次用法\/环境类/, `得解释清楚：${out.stdout}`);
  assert.match(out.stdout, /不算被拦/);
});

test("名单只有一份：gates.js 不许再自己抄一遍", () => {
  const src = fs.readFileSync(new URL("../src/gates.js", import.meta.url), "utf8");
  assert.match(src, /ENV_ONLY_CODES/, "gates.js 应该用 store.js 那份名单");
  assert.doesNotMatch(
    src,
    /new Set\(\[\s*"E_DIRTY_SCOPE"/,
    "gates.js 里不该有第二份名单——两处一漏就不自洽（T-117）",
  );
});

test("周报也认 env-only：查询里必须真的选出 detail（T-117 修过的坑）", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  run(root, ["release", "plan"]); // E_USAGE
  run(root, ["evidence", "run-nope"]); // NOT_FOUND

  // 早先 weekly 的 SQL 没选 detail，`detail !== "env-only"` 恒为真，
  // 于是一条都没被排除——stats 说 0、周报说 2，两处数字当场打架。
  const w = weekly(db, { days: 7 });
  assert.equal(w.totals.blocked, 0, "两条都不是纪律问题，周报也不能算");
  assert.equal(w.topBlocked.length, 0, "「主要拦在哪」里也不该出现它们");
});