// devcontrol — 多语言：bin/ 是源码还是产物，得看是什么项目
//
// Go 内测（进销存）撞出来的两处 npm 硬编码：
//   ① Go 项目 `go build -o bin/inv` 产出 3.9MB 二进制，init 写的 .gitignore 里没有 bin/，
//      于是它会被当交付物提交，或把收口堵在「scope 内有未跟踪文件」。
//   ② 建任务时默认验收写死 `npm test :: exit==0`，Go 项目契约里只有 `go test ./...`，
//      于是建任务第一句就 E_CONTRACT。
// 但 bin/ 不能一刀切：npm 包的 bin/ 是**源码**（package.json 的 bin 入口，内核自己就是 bin/devcontrol.js）。
// 所以判据跟着语言走。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeRepo, makeGoRepo, initFlow, newTask, sh, BIN } from "./helpers.js";
import { isVendorDir, isVendorPath, vendorIgnores } from "../src/vendor.js";
import { taskClaim } from "../src/gates.js";
import { openDb } from "../src/db.js";

const cli = (root, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "go-agent" },
  });

test("Go 项目：根目录 bin/ 是构建产物", () => {
  const root = makeGoRepo();
  assert.equal(isVendorDir("bin", root), true);
  assert.equal(isVendorPath("bin/inv", root), true);
});

test("npm 项目：bin/ 是源码，不能当产物（内核自己的 CLI 就在那里）", () => {
  const root = makeRepo();
  assert.equal(isVendorDir("bin", root), false);
  assert.equal(isVendorPath("bin/devcontrol.js", root), false);
});

test("Go 项目的 src/bin/ 仍然是源码（Rust 风格目录不能误伤）", () => {
  const root = makeGoRepo();
  // 只有仓库根或 workspace 包目录下的 bin 才算产物
  assert.equal(isVendorDir("src/bin", root), false);
  assert.equal(isVendorPath("src/bin/main.go", root), false);
});

test("init 给 Go 项目写 bin/ 到 .gitignore；npm 项目不写", () => {
  const go = makeGoRepo();
  assert.ok(vendorIgnores(go).includes("bin/"), "Go 项目要忽略 bin/");
  const node = makeRepo();
  assert.ok(!vendorIgnores(node).includes("bin/"), "npm 项目绝不能忽略 bin/（那是源码）");
});

test("Go 项目建任务不给 --accept 时，默认用契约里的第一条命令", async () => {
  const root = makeGoRepo();
  const { db } = initFlow(root, { testCmd: "go test ./...", allowed: ["."] });
  // 不带 --scope：顺便验证默认 scope 会折成具体目录（T-130），不会再是 `.`
  const r = cli(root, "task", "create", "--req", "FR-001", "--path", "P-001", "--title", "不给验收");
  assert.equal(r.status, 0, `建任务失败：${r.stdout}${r.stderr}`);
  const row = db.prepare("SELECT acceptance_json FROM tasks WHERE title=?").get("不给验收");
  const [a] = JSON.parse(row.acceptance_json);
  assert.equal(a.assertion, "go test ./... :: exit==0", "默认验收要跟着项目语言走，不能写死 npm test");
});

test("npm 项目不给 --accept 时，默认仍是 npm test（没被改坏）", () => {
  const root = makeRepo();
  const { db } = initFlow(root, { testCmd: "npm test" });
  const r = cli(root, "task", "create", "--req", "FR-001", "--path", "P-001", "--title", "不给验收", "--scope", "src");
  assert.equal(r.status, 0, r.stderr);
  const row = db.prepare("SELECT acceptance_json FROM tasks WHERE title=?").get("不给验收");
  assert.equal(JSON.parse(row.acceptance_json)[0].assertion, "npm test :: exit==0");
});

// T-130 之后 `.` 不再是合法 scope。这里改成顶层目录，语义上仍是全仓——
// 本用例要验的是「构建产物不进仓库」，不是 scope 边界。
test("Go 项目 scope 覆盖顶层目录时，commit 不会把 bin/ 里的二进制带进仓库", () => {
  const root = makeGoRepo();
  const { db } = initFlow(root, { testCmd: "go test ./...", allowed: ["."] });
  const t = newTask(db, root, "FR-001", { title: "改 main", scope: ["cmd"], acceptance: [{ deriveFrom: 0, assertion: "go test ./... :: exit==0" }] });
  taskClaim(db, root, { id: t.id }, "go-agent");

  // 构建产物 + 一处真源码改动
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin/inv"), "fake binary");
  fs.writeFileSync(path.join(root, "cmd/app/main.go"), "package main\n\nfunc main() { println(1) }\n");

  const r = cli(root, "commit", "-m", "feat: 改 main");
  assert.equal(r.status, 0, `commit 失败：${r.stdout}${r.stderr}`);
  const tracked = sh(root, "git", "ls-files").split("\n").filter(Boolean);
  assert.ok(!tracked.some((f) => f.startsWith("bin/")), `二进制不该进仓库：${tracked.filter((f) => f.startsWith("bin/")).join(",")}`);
  assert.ok(tracked.includes("cmd/app/main.go"), "真源码要提交进去");
});