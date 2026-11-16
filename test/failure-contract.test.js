// devcontrol — 失败也是 JSON：stdout 必须能整段 parse，且必带 code 与 hint
//
// 为什么值得一条测试：Agent 的每一次「被拦住」都要靠错误码分支处理
// （该等 Owner？该换任务？该重跑？）。如果某条路径只往 stderr 打一行纯文本，
// Agent 就只能靠正则猜，猜错就瞎试——演练里实际出现过 `被拦 ?` 这种输出，
// 因为 commit 的失败根本没给码。约定必须一条一条钉住。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, initFlow, newTask, BIN } from "./helpers.js";
import { taskClaim } from "../src/gates.js";
import { hintFor } from "../src/hints.js";

const run = (root, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "probe-agent" },
  });

/** 断言这次调用是一次「规格内的失败」：stdout 是 JSON，ok=false，有 code，有 hint */
function expectFailure(root, args, { code } = {}) {
  const r = run(root, ...args);
  assert.notEqual(r.status, 0, `本应失败却成功了：${args.join(" ")}`);
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    assert.fail(`stdout 不是 JSON（Agent 没法分支处理）：${args.join(" ")}\n原始 stdout: ${r.stdout.slice(0, 200)}`);
  }
  assert.equal(j.ok, false, `ok 必须是 false：${args.join(" ")}`);
  assert.ok(j.code, `失败必须带 code：${args.join(" ")}`);
  if (code) assert.equal(j.code, code, `${args.join(" ")} 的 code 不对`);
  assert.ok(j.hint, `失败必须带 hint（告诉 Agent 下一步做什么）：${j.code}`);
  return j;
}

test("用法写错：全是 E_USAGE，不是纯文本", () => {
  const root = makeRepo();
  initFlow(root);
  const cases = [
    ["commit"],
    ["task"],
    ["task", "claim"],
    ["doc", "add"],
    ["flow", "zzz"],
    ["release", "zzz"],
    ["memory", "zzz"],
    ["memory", "search"],
    ["zzz-不存在的命令"],
  ];
  for (const args of cases) expectFailure(root, args, { code: "E_USAGE" });
});

test("commit 的被拒都有码：没任务 / scope 外 / 没改动", () => {
  const root = makeRepo();
  const { db } = initFlow(root);

  // ① 没有在办任务
  expectFailure(root, ["commit", "-m", "x"], { code: "E_NO_TASK" });

  // ② 领了任务，但改动在 scope 外（P-001 允许 src，任务 scope 默认 src）
  const t = newTask(db, root, "FR-001", { title: "改 src", scope: ["src"] });
  taskClaim(db, root, { id: t.id }, "probe-agent");
  fs.writeFileSync(path.join(root, "outside.txt"), "不该在这里\n");
  const j = expectFailure(root, ["commit", "-m", "x"], { code: "E_SCOPE_VIOLATION" });
  assert.deepEqual(j.data.files, ["outside.txt"], "人话里也要能看出是哪个文件越界");
  assert.match(j.message, /outside\.txt/, "message 里必须带文件名，不能只有冒号");

  // ③ 清掉越界文件后，scope 内没有任何改动
  fs.rmSync(path.join(root, "outside.txt"));
  expectFailure(root, ["commit", "-m", "x"], { code: "E_NO_DELIVERY" });
});

test("evidence 找不到运行 → NOT_FOUND", () => {
  const root = makeRepo();
  initFlow(root);
  expectFailure(root, ["evidence", "run-does-not-exist"], { code: "NOT_FOUND" });
});

test("未知命令会给可用命令的入口，不会只说「未知」", () => {
  const root = makeRepo();
  initFlow(root);
  const j = expectFailure(root, ["no-such-thing"], { code: "E_USAGE" });
  assert.match(j.message, /devcontrol (--help|help)/);
});

test("help 与 bootstrap 两个别名都真的能用", () => {
  const root = makeRepo();
  initFlow(root);
  const help = run(root, "help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /devcontrol .* — /);

  const bs = run(root, "bootstrap");
  assert.equal(bs.status, 0);
  const digest = JSON.parse(bs.stdout);
  assert.ok(digest.sessionHead || digest.phase || digest.actions, "bootstrap 应返回与 status 相同的摘要");
});

test("claude/codex 之类会先敲 help：这条路径不能 404", () => {
  const root = makeRepo();
  initFlow(root);
  for (const alias of ["help", "--help", "-h"]) {
    const r = run(root, alias);
    assert.equal(r.status, 0, `${alias} 应该成功`);
    assert.match(r.stdout, /devcontrol init/, `${alias} 应打印用法`);
  }
});


test("每个会作为失败返回的错误码都配了 hint（新加码不许裸奔）", () => {
  // 从源码里直接提取「会抛给人看」的码，而不是靠人维护一份清单——
  // 清单会忘记更新，源码不会。
  const SRC = path.join(import.meta.dirname, "..", "src");
  const thrown = new Set();
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith(".js"))) {
    const body = fs.readFileSync(path.join(SRC, f), "utf8");
    for (const m of body.matchAll(/fail\(\s*"([A-Z][A-Z0-9_]+)"/g)) thrown.add(m[1]);
    for (const m of body.matchAll(/new DFError\(\s*"([A-Z][A-Z0-9_]+)"/g)) thrown.add(m[1]);
  }
  assert.ok(thrown.size > 20, `提取到的错误码太少（${thrown.size}），正则可能失效了`);

  const missing = [...thrown].filter((c) => !hintFor({ code: c })).sort();
  assert.deepEqual(missing, [], `这些错误码会返回给 Agent，但没有 hint：${missing.join(", ")}`);
});
