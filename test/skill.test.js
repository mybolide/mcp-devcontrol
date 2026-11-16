// devcontrol — Agent 侧安装物：规范 Skill + 指针 + AGENTS/CLAUDE 块
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { makeRepo, BIN } from "./helpers.js";
import { SKILL_REL, CURSOR_RULE_REL } from "../src/skill.js";

const init = (root, args = ["init", "--no-mcp"]) => execFileSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8" });
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("init 装好规范 Skill 与各客户端指针", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  init(root);

  const skill = read(root, SKILL_REL);
  assert.match(skill, /^---\nname: devcontrol/, "Skill 要有 frontmatter");
  assert.match(skill, /description: >-/, "要有 description");
  assert.match(skill, /version: "/, "要带版本");
  assert.match(skill, /DEVCONTROL_ACTOR/, "必须写清多 Agent 各自用不同 actor");
  assert.match(skill, /E_SCOPE_OVERLAP/, "要有被拦了怎么办");
  assert.match(skill, /devcontrol close/, "要有收口步骤");

  assert.match(read(root, CURSOR_RULE_REL), /alwaysApply: true/, "Cursor 规则要自动生效");
  assert.match(read(root, CURSOR_RULE_REL), new RegExp(SKILL_REL.replace(/\./g, "\\.")), "Cursor 规则要指向规范 Skill");
  assert.match(read(root, "CLAUDE.md"), /devcontrol:begin/, "CLAUDE.md 要有标记块");
  assert.match(read(root, "AGENTS.md"), /devcontrol:begin/, "AGENTS.md 要有标记块");
  assert.match(read(root, "AGENTS.md"), /DEVCONTROL_ACTOR/, "AGENTS.md 也要提 actor");
});

test("重复 init 幂等，且不吞掉用户原有内容", () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# 我们自己的规矩\n\n先看设计文档。\n");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Claude 说明\n\n已有内容。\n");
  init(root);
  const agents1 = read(root, "AGENTS.md");
  const skill1 = read(root, SKILL_REL);
  init(root);
  assert.equal(read(root, "AGENTS.md"), agents1, "AGENTS.md 第二次 init 不该变化");
  assert.equal(read(root, SKILL_REL), skill1, "Skill 不该变化");
  assert.equal((read(root, "AGENTS.md").match(/devcontrol:begin/g) ?? []).length, 1, "块不能重复");
  assert.equal((read(root, "CLAUDE.md").match(/devcontrol:begin/g) ?? []).length, 1, "CLAUDE.md 块不能重复");
  assert.match(read(root, "AGENTS.md"), /我们自己的规矩/, "用户原有内容要保留");
  assert.match(read(root, "CLAUDE.md"), /已有内容/, "CLAUDE.md 原有内容要保留");
});

test("init 把自己写的 Agent 文件提交进仓库（第一次 close 不会被脏树拦住）", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  init(root);
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  for (const f of [SKILL_REL, CURSOR_RULE_REL, "AGENTS.md", "CLAUDE.md"]) {
    assert.ok(tracked.includes(f), `${f} 应该已被提交`);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("控制台启动时自动补齐 Agent 说明（老项目也跟上）", async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  init(root);
  // 模拟一个早先 init 过、但没有这些说明文件的仓库
  fs.rmSync(path.join(root, ".agents"), { recursive: true, force: true });
  fs.rmSync(path.join(root, ".cursor", "rules"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "CLAUDE.md"), { force: true });
  const port = 28000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      await sleep(150);
      try {
        up = (await fetch(`http://127.0.0.1:${port}/api/meta`)).ok;
      } catch {
        up = false;
      }
    }
    assert.ok(up, "控制台没起来");
    assert.ok(fs.existsSync(path.join(root, SKILL_REL)), "启动后应补回 SKILL.md");
    assert.ok(fs.existsSync(path.join(root, CURSOR_RULE_REL)), "启动后应补回 Cursor 规则");
    assert.ok(fs.existsSync(path.join(root, "CLAUDE.md")), "启动后应补回 CLAUDE.md");
  } finally {
    child.kill("SIGTERM");
  }
});

test("MCP 每次连上都把 Agent 说明对齐（升级后自愈）", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  init(root);
  fs.rmSync(path.join(root, ".agents"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "CLAUDE.md"), { force: true });
  // 起一次 MCP（stdin 立刻 EOF），它会按当前代码把说明文件对齐
  execFileSync(process.execPath, [BIN, "mcp"], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_CONSOLE: "0", DEVCONTROL_MEMORY: "off" },
    input: "",
    timeout: 20000,
  });
  assert.ok(fs.existsSync(path.join(root, SKILL_REL)), "MCP 启动后应补回 SKILL.md");
  assert.ok(fs.existsSync(path.join(root, "CLAUDE.md")), "MCP 启动后应补回 CLAUDE.md");
});

test("项目不用 Cursor / Claude 时，不给它塞指针文件", () => {
  const root = makeRepo();
  init(root);
  assert.ok(fs.existsSync(path.join(root, SKILL_REL)), "通用说明要写");
  assert.ok(fs.existsSync(path.join(root, "AGENTS.md")), "AGENTS.md 要写");
  assert.ok(!fs.existsSync(path.join(root, CURSOR_RULE_REL)), "没装 Cursor 不该写 .cursor/rules");
  assert.ok(!fs.existsSync(path.join(root, "CLAUDE.md")), "没用 Claude 不该写 CLAUDE.md");
});
