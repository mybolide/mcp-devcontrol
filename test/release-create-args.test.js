// release create 的标题写法：「位置参数是标题，开关只改选项」。
//
// 起因是真实踩坑：`devcontrol release create --title "客户合并"` 里
// args[1] 正好是 `--title` 这个开关本身，于是标题变成了 "--title"，
// ship 时 slug 化成 "title"，tag 成了 release/R-002-title-2026-11-18。
// 同一个坑 T-115 在 `release plan` 上踩过一次，这里补上 create 的。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { BIN, makeRepo } from "./helpers.js";

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