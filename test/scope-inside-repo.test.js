// 任务 scope 只能是仓库内的相对路径。
//
// 起因是真实踩坑：`task create --scope /tmp/x`、`--scope ../x`、`--scope ~/.zshrc`
// 全都被接受了。scope 是内核「批准你改哪些文件」的凭据，批准一个仓库外的路径
// 等于让 Agent 名正言顺地改本机任意文件——而 git 看不见它们，既不进 diff、
// 也进不了证据指纹。护栏产品自己的护栏上有洞，比不设护栏更糟。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { makeRepo, initFlow, newTask, BIN } from "./helpers.js";
import { taskAdjust } from "../src/store.js";
import { assertScopeInsideRepo } from "../src/scope.js";

const run = (cwd, args) => {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

const OUTSIDE = [
  "/tmp/abs.txt",
  "/etc/passwd",
  "../escape.txt",
  "src/../../escape.txt",
  "~/evil.txt",
  "~",
  "C:\\Windows\\x.txt",
];

test("校验函数本身：绝对路径 / .. / ~ / Windows 盘符一律拒", () => {
  for (const s of OUTSIDE) {
    assert.throws(
      () => assertScopeInsideRepo([s]),
      (err) => err.code === "E_CONTRACT",
      `scope ${s} 应当被拒`,
    );
  }
});

test("校验函数本身：正常的仓库内相对路径放行", () => {
  for (const s of ["src", "src/gates.js", "./src/a.js", "test/a.test.js", ".", "a/b/c/d.txt"]) {
    assert.doesNotThrow(() => assertScopeInsideRepo([s]), `scope ${s} 不该被拒`);
  }
});

test("task create --scope /tmp/abs.txt 被拒，且不建出任务", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const before = db.prepare("SELECT COUNT(*) n FROM tasks").get().n;

  for (const s of OUTSIDE) {
    const out = run(root, [
      "task", "create",
      "--req", reqId, "--path", "P-001",
      "--title", `t-${s}`,
      "--scope", s,
    ]);
    assert.notEqual(out.code, 0, `scope ${s} 应当失败，实际通过：${out.stdout}`);
    assert.match(out.stderr + out.stdout, /scope/, `拒绝理由要提到 scope：${out.stderr}`);
  }

  const after = db.prepare("SELECT COUNT(*) n FROM tasks").get().n;
  assert.equal(after, before, "被拒的 scope 不该留下任务");
});

test("taskAdjust（Owner 放宽 scope）同样拦住仓库外路径", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/a.js"] });

  for (const s of OUTSIDE) {
    assert.throws(
      () => taskAdjust(db, root, { taskId: t.id, scope: [s], reason: "想改仓库外的文件" }),
      (err) => err.code === "E_CONTRACT",
      `adjust 到 ${s} 应当被拒`,
    );
  }

  // 放宽到合法的相对路径仍然可以
  const ok = taskAdjust(db, root, { taskId: t.id, scope: ["src/a.js", "src/b.js"], reason: "这条任务本来就该改两个文件" });
  assert.deepEqual(ok.scope, ["src/a.js", "src/b.js"]);
});

test("被拒之后已有 scope 不被改动（整笔回滚）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/a.js"] });

  assert.throws(() => taskAdjust(db, root, { taskId: t.id, scope: ["/tmp/x"], reason: "越界尝试" }));

  const after = db.prepare("SELECT scope_json FROM tasks WHERE id=?").get(t.id);
  assert.deepEqual(JSON.parse(after.scope_json), ["src/a.js"], "失败的 adjust 不该改掉原 scope");
});
