// release create 的标题写法：「位置参数是标题，开关只改选项」。
//
// 起因是真实踩坑：`devcontrol release create --title "客户合并"` 里
// args[1] 正好是 `--title` 这个开关本身，于是标题变成了 "--title"，
// ship 时 slug 化成 "title"，tag 成了 release/R-002-title-2026-11-18。
// 同一个坑 T-115 在 `release plan` 上踩过一次，这里补上 create 的。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { BIN, makeRepo } from "./helpers.js";

// 用 spawnSync 而不是 execFileSync：后者成功时拿不到 stderr，
// 于是「成功但提醒了一句」这类断言会假通过（T-128 的测试就先踩了这个坑）。
const run = (cwd, args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

function freshRepo() {
  const root = makeRepo();
  const init = run(root, ["init", "--no-mcp"]);
  assert.equal(init.code, 0, init.stderr);
  return root;
}

test("release create 位置参数是标题", () => {
  const root = freshRepo();
  const out = run(root, ["release", "create", "v0.1"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).title, "v0.1");
});

test("release create --title X：标题是 X 的值，不是 --title 这个开关本身", () => {
  const root = freshRepo();
  const out = run(root, ["release", "create", "--title", "客户合并"]);
  assert.equal(out.code, 0, out.stderr);
  const rel = JSON.parse(out.stdout);
  assert.equal(rel.title, "客户合并", `标题被解析成了 ${JSON.stringify(rel.title)}`);
  assert.notEqual(rel.title, "--title");
});

test("release create --target 也能和 --title 一起用，互不干扰", () => {
  const root = freshRepo();
  const out = run(root, ["release", "create", "--title", "客户合并", "--target", "2026-12-01"]);
  assert.equal(out.code, 0, out.stderr);
  const rel = JSON.parse(out.stdout);
  assert.equal(rel.title, "客户合并");
  assert.equal(rel.target_date, "2026-12-01");
});

test("release create 既没位置参数也没 --title 时，报用法错而不是造一条名字叫 --title 的发布", () => {
  const root = freshRepo();
  const out = run(root, ["release", "create", "--target", "2026-12-01"]);
  assert.equal(out.code, 2, "用法错应当是退出码 2");
  assert.match(out.stderr, /用法/);

  const list = run(root, ["release", "list"]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /还没有发布/, "不该留下一条垃圾发布");
});

// T-128：位置参数和 --title 同时给时，早先是 `positional[0] ?? flag("title")`，
// 于是 --title 被静默压掉——`release create "R-011" --title "审核发现的账要算对"`
// 造出来的标题是 "R-011"。这已经是同一个坑的第三个入口（T-115 plan、T-120 create）。
test("位置参数 + --title 同时给：--title 赢，不许被静默压掉", () => {
  const root = freshRepo();
  const out = run(root, ["release", "create", "R-011", "--title", "审核发现的账要算对"]);
  assert.equal(out.code, 0, out.stderr);
  const rel = JSON.parse(out.stdout);
  assert.equal(rel.title, "审核发现的账要算对", `标题被压成了 ${JSON.stringify(rel.title)}`);
  // 发布号由内核生成，不该是用户随手写的那串
  assert.match(rel.id, /^R-\d+$/);
});

test("位置参数长得像发布号、又没给 --title：照用，但要提醒一句", () => {
  const root = freshRepo();
  const out = run(root, ["release", "create", "R-011"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).title, "R-011");
  assert.match(out.stderr, /看起来是发布号/, `该提醒一句，实际 stderr：${out.stderr}`);
});