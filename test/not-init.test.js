// devcontrol — 别报喜不报忧
//
// 四处：未初始化却装作有项目、init 说写了没写的文件、serve 抢不到端口还返 0、
// status 的 console 字段永远是 null（而 AGENTS.md 让 Agent 去那里找地址）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { makeRepo, BIN } from "./helpers.js";

const run = (root, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "t" },
  });

const PORT = 45000 + Math.floor(Math.random() * 8000);

test("git 仓库但还没 init：明确说没项目，不凭空造一个空库", () => {
  const root = makeRepo();
  const r = run(root, "stats");
  assert.notEqual(r.status, 0);
  assert.equal(JSON.parse(r.stdout).code, "E_NOT_INIT");
  assert.ok(JSON.parse(r.stdout).hint, "得告诉人下一步是 init");
  assert.equal(fs.existsSync(path.join(root, ".devcontrol", "state.db")), false, "不许凭空建库");
});

test("init 打印的 Agent 说明和实际写的一致，不谎报 CLAUDE.md", () => {
  const root = makeRepo();
  const r = run(root, "init", "--no-mcp");
  assert.equal(r.status, 0, r.stderr);

  const wrote = fs.readdirSync(root);
  assert.ok(wrote.includes("AGENTS.md"), "通用约定一直写");
  // makeRepo 里既没有 CLAUDE.md 也没有 .claude/，所以它不该被写，更不该被说成写了
  assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), false);
  assert.doesNotMatch(r.stdout, /CLAUDE\.md/, "没写就别印出来");
  assert.match(r.stdout, /AGENTS\.md/);
});

test("init 的 .gitignore 认得 console.json，不然每个项目都带一个未跟踪文件", () => {
  const root = makeRepo();
  run(root, "init", "--no-mcp");
  fs.writeFileSync(path.join(root, ".devcontrol", "console.json"), "{}");
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  assert.doesNotMatch(r.stdout, /console\.json/, "它还露在 git status 里");
});

test("--no-mcp 时不再声称「随 MCP 连接自动启动」", () => {
  const root = makeRepo();
  const r = run(root, "init", "--no-mcp");
  assert.doesNotMatch(r.stdout, /随 MCP 连接自动启动/);
  assert.match(r.stdout, /纯 CLI 模式/);
});

test("serve 抢不到端口：返回非 0，不假装成功", async () => {
  const root = makeRepo();
  run(root, "init", "--no-mcp");

  const squatter = net.createServer();
  await new Promise((res) => squatter.listen(PORT, "127.0.0.1", res));

  const child = spawn(process.execPath, [BIN, "serve", "--port", String(PORT)], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_OWNER_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const code = await new Promise((res) => {
    const timer = setTimeout(() => {
      child.kill();
      res("timeout");
    }, 15000);
    child.on("exit", (c) => {
      clearTimeout(timer);
      res(c);
    });
  });
  squatter.close();

  assert.notEqual(code, 0, "端口被别人占着却返回 0，脚本会以为起来了");
});

test("控制台起来之后，status 的 console 字段不再为 null", async () => {
  const root = makeRepo();
  run(root, "init", "--no-mcp");

  const child = spawn(process.execPath, [BIN, "serve", "--port", String(PORT + 1)], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_OWNER_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`serve 未就绪：${out}`)), 15000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes("项目：")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });

  try {
    const r = run(root, "status");
    assert.equal(r.status, 0, r.stderr);
    const digest = JSON.parse(r.stdout);
    assert.equal(digest.console, `http://127.0.0.1:${PORT + 1}/`, "AGENTS.md 让人去这个字段找地址");
  } finally {
    child.kill();
  }
});

test("进程死了留下的 console.json 不能当成活的", () => {
  const root = makeRepo();
  run(root, "init", "--no-mcp");
  // 伪造一个崩溃残留：pid 早就没了
  fs.writeFileSync(
    path.join(root, ".devcontrol", "console.json"),
    JSON.stringify({ port: 9, root, pid: 999999, at: new Date().toISOString() }),
  );

  const r = run(root, "status");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).console, null, "死进程的残留地址不能当真");
});