// T-130：scope 不许写成 `.`。
//
// 起因是一次真实实测：任务 scope 写成 `.` 之后，Agent 完全不理既有的 math.js，
// 另写了 lib/calc/ + helpers/ + 自己的测试，4 个文件、3 层重复包装——
// commit 通过、close 通过、被拦 0、返工 0。内核一个字都没看见。
//
// 根因是 scope 与 Path 的 allowed_paths 共用一个值：Path 授权整个仓库时是 `.`，
// 而 `.` 在 inScope() 里表示「仓库里任何文件都算你的」。于是「任务到底动哪几片地」
// 这件事根本没被写下来，内核也就无从拦起。
//
// 现在：Path 仍然可以授权整个仓库（那是授权上限），但任务的 scope 必须落到
// 具体目录/文件；不给 scope 时按仓库顶层目录折一个具体的出来。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BIN, makeRepo } from "./helpers.js";
import { spawnSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { reqIntake, reqApprove } from "../src/store.js";
import { taskCreate } from "../src/gates.js";
import { assertScopeIsSpecific, concreteTopDirs, suggestScope } from "../src/scope.js";

const run = (cwd, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** 走一遍 需求 → 批准 → 可建任务 的状态；P-001 的 allowed_paths 由 init 决定 */
function ready(root) {
  const db = openDb(root);
  const req = reqIntake(db, root, { type: "requirement", title: "r", goal: "g", acceptance: ["npm test :: exit==0"] });
  reqApprove(db, root, { requirementId: req.id, pathId: "P-001" });
  return { db, req };
}

test("assertScopeIsSpecific：`.` / 空串 / `**` 一律拒，并说清为什么", () => {
  for (const bad of [["."], [""], ["**"], ["./"], ["/"]]){
    assert.throws(
      () => assertScopeIsSpecific(bad),
      (e) => {
        assert.equal(e.code, "E_CONTRACT");
        assert.match(e.message, /整个仓库/);
        assert.match(e.hint, /等于没有 scope/);
        return true;
      },
      `这些写法都该被拒：${JSON.stringify(bad)}`,
    );
  }
});

test("assertScopeIsSpecific：具体目录和文件照常放行", () => {
  assertScopeIsSpecific(["src", "src/gates.js", "test", "cmd/app"]);
  assertScopeIsSpecific([]);
  assertScopeIsSpecific(undefined);
});

test("taskCreate：scope 给 `.` 直接拒，且不会先把任务写进库", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  const { db, req } = ready(root);
  assert.throws(
    () => taskCreate(db, root, { requirementId: req.id, pathId: "P-001", title: "另起一套", scope: ["."] }),
    (e) => {
      assert.equal(e.code, "E_CONTRACT");
      return true;
    },
  );
  const n = db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
  assert.equal(n, 0, "被拒的任务不该留在库里");
});

test("taskCreate：不给 scope 时折成仓库顶层目录，不再默认 `.`", () => {
  const root = makeRepo(); // makeRepo 里只有 src/
  run(root, ["init", "--no-mcp"]);
  const { db, req } = ready(root);
  const t = taskCreate(db, root, {
    requirementId: req.id,
    pathId: "P-001",
    title: "不给 scope",
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  assert.ok(t.scope.length > 0, "默认 scope 不能是空的");
  assert.equal(t.scope.includes("."), false, `默认 scope 不能是整个仓库：${JSON.stringify(t.scope)}`);
  assert.ok(t.scope.every((s) => fs.existsSync(path.join(root, s))), `默认 scope 应当是真实存在的目录：${JSON.stringify(t.scope)}`);
  assert.ok(t.scope.includes("src"), `顶层目录 src 该在默认 scope 里，实际 ${JSON.stringify(t.scope)}`);
});

test("concreteTopDirs：跳过隐藏目录与 node_modules", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
  fs.mkdirSync(path.join(root, ".devcontrol/runs"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  const dirs = concreteTopDirs(root);
  assert.equal(dirs.includes("node_modules"), false);
  assert.equal(dirs.includes(".devcontrol"), false);
  assert.ok(dirs.includes("lib"), `lib 该被算进去：${JSON.stringify(dirs)}`);
});

test("suggestScope：Path 授权具体目录就照抄；授权整仓就折成顶层目录", () => {
  const root = makeRepo();
  assert.deepEqual(suggestScope(root, ["src", "test"]), ["src", "test"]);
  const folded = suggestScope(root, ["."]);
  assert.equal(folded.includes("."), false, `折完之后不该还有 .：${JSON.stringify(folded)}`);
  assert.ok(folded.includes("src"));
});

test("CLI：init 之后不带 --scope 建任务照样能成，且 scope 不是整仓", () => {
  const root = makeRepo();
  const init = run(root, ["init", "--no-mcp"]);
  assert.equal(init.code, 0, init.stderr);
  const intake = run(root, ["intake", "加法要支持负数", "--accept", "npm test :: exit==0"]);
  assert.equal(intake.code, 0, intake.stderr);
  const fr = intake.stdout.match(/FR-\d+/)[0];
  assert.equal(run(root, ["approve", fr, "--path", "P-001"]).code, 0);

  const created = run(root, ["task", "create", "--req", fr, "--path", "P-001", "--title", "不带 scope"]);
  assert.equal(created.code, 0, `不带 --scope 该能建成：${created.stderr}`);
  const scopeLine = created.stdout.split("\n").find((l) => l.startsWith("scope:"));
  assert.ok(scopeLine, `输出里该有 scope 一行：${created.stdout}`);
  assert.equal(/\.\s*$/.test(scopeLine), false, `scope 不能是整仓：${scopeLine}`);
  assert.match(scopeLine, /src/, `scope 该落到具体目录：${scopeLine}`);
});

// next 给的是「照抄就能跑」的命令，所以它不能建议 --scope .（那现在已经非法）
test("next 不会建议 --scope .（否则照抄必被拒）", () => {
  const root = makeRepo();
  assert.equal(run(root, ["init", "--no-mcp"]).code, 0);
  const intake = run(root, ["intake", "加法要支持负数", "--accept", "npm test :: exit==0"]);
  const fr = intake.stdout.match(/FR-\d+/)[0];
  assert.equal(run(root, ["approve", fr, "--path", "P-001"]).code, 0);
  const next = run(root, ["next"]);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(/--scope\s+\.(\s|$)/m.test(next.stdout), false, `next 不能建议 --scope .：\n${next.stdout}`);
});
