// devcontrol — 纯 CLI 建任务时，scope 必须能一次说全
// 事故：`--scope src/cli.js --scope test/x.test.js` 只留了最后一个，测试文件没进 scope，
// 于是写测试的那一步被自己的 scope 检查拦住（T-086 就是这么撞的）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeRepo, initFlow, BIN } from "./helpers.js";

const cli = (root, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "cli-agent" },
  });

const ALLOWED = ["src", "test"];
const scopeOf = (db, title) => JSON.parse(db.prepare("SELECT scope_json FROM tasks WHERE title=?").get(title).scope_json);

const create = (root, title, ...scopeArgs) =>
  cli(root, "task", "create", "--req", "FR-001", "--path", "P-001", "--title", title, ...scopeArgs);

test("--scope 重复写：两个都在，不是只剩最后一个", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });

  const r = create(root, "两段", "--scope", "src/a.js", "--scope", "test/a.test.js");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scopeOf(db, "两段"), ["src/a.js", "test/a.test.js"]);
});

test("--scope 逗号分隔：照旧可用", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });

  const r = create(root, "逗号", "--scope", "src/a.js,test/a.test.js");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scopeOf(db, "逗号"), ["src/a.js", "test/a.test.js"]);
});

test("--scope 重复 + 逗号混着写：全都算数", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });

  const r = create(root, "混写", "--scope", "src/a.js,src/b.js", "--scope", "test/a.test.js");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scopeOf(db, "混写"), ["src/a.js", "src/b.js", "test/a.test.js"]);
});

test("--scope 里的空格与空段被丢掉，不会种出空字符串 scope", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });

  const r = create(root, "脏值", "--scope", " src/a.js , ,test/a.test.js ");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scopeOf(db, "脏值"), ["src/a.js", "test/a.test.js"]);
});

test("不给 --scope 时回落成 Path 的 allowed_paths（不是空 scope）", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });

  const r = create(root, "不指定");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scopeOf(db, "不指定"), ALLOWED);
});

test("多段 scope 会原样打印出来，人能看见自己建了个什么", () => {
  const root = makeRepo();
  initFlow(root, { allowed: ALLOWED });

  const r = create(root, "打印", "--scope", "src/a.js", "--scope", "test/a.test.js");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /scope: src\/a\.js, test\/a\.test\.js/);
});