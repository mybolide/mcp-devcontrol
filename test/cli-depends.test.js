// devcontrol — 纯 CLI 也要能表达「这个任务等那个任务」
// 复杂系统（后端先出接口，前端再接）必然有依赖；MCP 侧一直有 dependsOn，CLI 侧不能缺。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeRepo, initFlow, newTask, BIN } from "./helpers.js";

const cli = (root, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "cli-agent" },
  });

const deps = (db, title) => JSON.parse(db.prepare("SELECT depends_on_json FROM tasks WHERE title=?").get(title).depends_on_json);

test("task create --depends 把前置写进任务，并在输出里说清楚", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const first = newTask(db, root, "FR-001", { title: "后端出接口", scope: ["src"] });

  const r = cli(root, "task", "create", "--req", "FR-001", "--path", "P-001", "--title", "前端接接口", "--scope", "src", "--depends", first.id);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /前置: T-001/);
  assert.deepEqual(deps(db, "前端接接口"), [first.id]);
});

test("--depends 支持重复写与逗号分隔两种写法", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const a = newTask(db, root, "FR-001", { title: "A" });
  const b = newTask(db, root, "FR-001", { title: "B" });

  const r = cli(root, "task", "create", "--req", "FR-001", "--path", "P-001", "--title", "C", "--depends", a.id, "--depends", b.id);
  assert.equal(r.status, 0, r.stderr);
  const r2 = cli(root, "task", "create", "--req", "FR-001", "--path", "P-001", "--title", "D", "--depends", `${a.id},${b.id}`);
  assert.equal(r2.status, 0, r2.stderr);

  assert.deepEqual(deps(db, "C"), [a.id, b.id]);
  assert.deepEqual(deps(db, "D"), [a.id, b.id]);
});

test("不带 --depends 时前置是空的，不会写成 [\"undefined\"]", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const r = cli(root, "task", "create", "--req", "FR-001", "--path", "P-001", "--title", "独立任务");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /前置/);
  assert.deepEqual(deps(db, "独立任务"), []);
});

test("依赖不存在的任务会被拦住，报 E_CONTRACT 而不是静默记账", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const r = cli(root, "task", "create", "--req", "FR-001", "--path", "P-001", "--title", "等幽灵", "--depends", "T-999");
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /E_CONTRACT/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tasks WHERE title=?").get("等幽灵").c, 0);
});

test("前置没做完时 claim 被拦 E_DEP_OPEN——依赖不是装饰", async () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const { taskClaim } = await import("../src/gates.js");
  const backend = newTask(db, root, "FR-001", { title: "后端" });
  const frontend = newTask(db, root, "FR-001", { title: "前端", dependsOn: [backend.id] });

  assert.throws(
    () => taskClaim(db, root, { id: frontend.id }, "cli-agent"),
    (e) => e.code === "E_DEP_OPEN" && /前置 T-001/.test(e.message),
  );
});
