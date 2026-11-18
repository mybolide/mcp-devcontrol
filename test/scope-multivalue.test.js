// devcontrol — 多值开关（--scope / --depends）三种写法都得认：可重复、逗号、空格。
//
// 事故（T-126）：只按 "," 切，于是 `--scope "src/a.js src/b.js"` 整串被当成**一条**路径存进
// scope。之后 commit 时这两个文件都算「scope 外」，报错还说
//   scope=src/a.js src/b.js：src/a.js、src/b.js 不在 scope 内
// 印出来的 scope 和「不在 scope 内」的文件一模一样，Agent 在这句话上反复打转，
// 而它自己的做法（把两个文件一起写进 --scope）完全合理。
//
// 同一类坑第三次出现：T-115 / T-120 是「开关名被当成值」，这次是「多值没切开」。
// 所以两种表现都测：解析要拆开，报错也要能看出是「一条」还是「两条」。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

test("--scope 空格分隔（整串一个参数）：拆成两条，不是一条", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });

  // 这是最容易踩的写法：加了引号，shell 原样递一个参数进来
  const r = create(root, "空格整串", "--scope", "src/a.js test/a.test.js");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scopeOf(db, "空格整串"), ["src/a.js", "test/a.test.js"]);
});

test("--scope 空格分隔（不加引号，两个参数）：第二条不许被悄悄吃掉", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });

  const r = create(root, "空格分参", "--scope", "src/a.js", "test/a.test.js");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scopeOf(db, "空格分参"), ["src/a.js", "test/a.test.js"]);
});

test("--scope 三种写法混用：全都算数", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });

  const r = create(root, "三种混用", "--scope", "src/a.js src/b.js,test/a.test.js", "--scope", "test/b.test.js");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scopeOf(db, "三种混用"), ["src/a.js", "src/b.js", "test/a.test.js", "test/b.test.js"]);
});

test("--scope 后紧跟别的开关：不会把开关名当成路径", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });

  const r = create(root, "后接开关", "--scope", "src/a.js", "--accept", "npm test :: exit==0");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scopeOf(db, "后接开关"), ["src/a.js"]);
});

test("文件名里本来就带空格，且真实存在：整串保留，不拆", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });
  const spaced = path.join(root, "src", "my file.js");
  fs.writeFileSync(spaced, "export const x = 1;\n");

  const r = create(root, "带空格文件名", "--scope", "src/my file.js");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scopeOf(db, "带空格文件名"), ["src/my file.js"]);
});

test("--depends 也认空格分隔", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });
  create(root, "前置一", "--scope", "src/a.js");
  create(root, "前置二", "--scope", "src/b.js");
  const r = create(root, "带前置", "--scope", "src/c.js", "--depends", "T-001 T-002");
  assert.equal(r.status, 0, r.stderr);
  const row = db.prepare("SELECT depends_on_json FROM tasks WHERE title=?").get("带前置");
  assert.deepEqual(JSON.parse(row.depends_on_json), ["T-001", "T-002"]);
});

// 老数据（或别的入口）里可能已经存着一条带空白的 scope。那时 commit 不能自相矛盾：
// 必须看得出「这是一条」，而不是「这是两个文件」。
test("scope 里有一条带空白时，报错要看得出来是一条，不许自相矛盾", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { allowed: ALLOWED });
  create(root, "脏数据", "--scope", "src/a.js,test/a.test.js");
  db.prepare("UPDATE tasks SET scope_json=? WHERE title=?").run(JSON.stringify(["src/a.js test/a.test.js"]), "脏数据");

  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  const claim = cli(root, "task", "claim", "T-001");
  assert.equal(claim.status, 0, claim.stderr);
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");
  fs.writeFileSync(path.join(root, "test/a.test.js"), "// 改一下\n");

  const r = cli(root, "commit", "-m", "x");
  assert.equal(r.status, 1, "应当被 scope 拦住");
  const out = JSON.parse(r.stdout);
  assert.equal(out.code, "E_SCOPE_VIOLATION");
  // 一条带空白的路径必须被引号包起来，否则印出来就像两个文件
  assert.ok(out.message.includes('"src/a.js test/a.test.js"'), `scope 要印成一条：${out.message}`);
});
