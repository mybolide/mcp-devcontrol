// devcontrol — init 的客户端配置：仓库被移动/复制后要跟着改，且不能弄坏用户的其他 MCP server
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { makeRepo, BIN, sh } from "./helpers.js";

const runInit = (root, args = []) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "init", ...args], { cwd: root, env: { ...process.env, DEVCONTROL_ROOT: root } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });

test("旧的 .mcp.json 指向别处：init 会按新路径更新，并保留其他 MCP server", async () => {
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "devcontrol": { command: "node", args: ["/old/path/bin/devcontrol.js", "mcp"], env: { DEVCONTROL_ROOT: "/old/project" } },
        other: { command: "node", args: ["other.js"] },
      },
    }),
  );

  const res = await runInit(root);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /已按新路径更新/);

  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.equal(path.resolve(cfg.mcpServers["devcontrol"].env.DEVCONTROL_ROOT), path.resolve(root));
  assert.deepEqual(cfg.mcpServers.other, { command: "node", args: ["other.js"] }, "不能删掉别人的 server");
});

test("配置已经指向本项目：init 不动它（幂等）", async () => {
  const root = makeRepo();
  assert.equal((await runInit(root)).code, 0);
  const before = fs.readFileSync(path.join(root, ".mcp.json"), "utf8");
  assert.equal((await runInit(root)).code, 0);
  assert.equal(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"), before);
});
test("--no-mcp：只写 AGENTS.md，不写任何客户端配置，纪律块改成 CLI 说法", async () => {
  const root = makeRepo();
  const res = await runInit(root, ["--no-mcp"]);
  assert.equal(res.code, 0, res.out);
  assert.ok(!fs.existsSync(path.join(root, ".mcp.json")), "不该写 .mcp.json");
  assert.ok(!fs.existsSync(path.join(root, ".cursor", "mcp.json")), "不该写 cursor 配置");
  assert.ok(!fs.existsSync(path.join(root, "opencode.json")), "不该写 opencode 配置");
  assert.match(res.out, /纯 CLI 模式/);

  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /devcontrol status/);
  assert.match(agents, /devcontrol close/);
  // 说明文件不再按「有没有接 MCP」分叉（否则 init 与 MCP 启动会互相覆盖），
  // 统一写「接了 MCP 自动拉起，没接就自己起」，所以这里断言 serve 提示而不是「不注册 MCP」
  assert.match(agents, /devcontrol serve/);
});

test("客户端配置按需生成：不用的客户端不往仓库里塞文件", async () => {
  // 公开仓库踩到的：.mcp.json 里写着 /Users/<某人>/.../node 和 .../devcontrol.js，
  // 而且一个只用 Claude Code 的仓库里也躺着 .cursor/ 和 opencode.json —— 那是噪音，
  // 谁也不知道该不该留、改了会不会被下次 init 覆盖。
  const root = makeRepo();
  const { code } = await runInit(root);
  assert.equal(code, 0);
  // 通用入口照写：不写就等于 init 完还得手工配一遍
  assert.ok(fs.existsSync(path.join(root, ".mcp.json")), ".mcp.json 该被写出来");
  // 没在用 Cursor / OpenCode：一份都不该出现
  assert.ok(!fs.existsSync(path.join(root, ".cursor")), "没在用 Cursor 就不该建 .cursor/");
  assert.ok(!fs.existsSync(path.join(root, "opencode.json")), "没在用 OpenCode 就不该写 opencode.json");
  // 但凡是写出来的，都绝不能进仓库：里面是本机绝对路径
  const tracked = sh(root, "git", "ls-files").split("\n");
  assert.ok(!tracked.includes(".mcp.json"), "本机绝对路径的配置不该提交");
  const status = sh(root, "git", "status", "--porcelain").trim();
  assert.equal(status, "", `init 之后工作树该干净，实际有：\n${status}`);
});

test("项目在用那个客户端就写它的配置：.cursor/ 在 → mcp.json 和 rules 一起写", async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
  const { code } = await runInit(root);
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(root, ".cursor/mcp.json")), "检测到 .cursor/ 就该写它的 MCP 配置");
  assert.ok(fs.existsSync(path.join(root, ".cursor/rules/devcontrol.mdc")), "判据要和 agent 说明文件同一套");
  assert.ok(!fs.existsSync(path.join(root, "opencode.json")), "没在用 OpenCode 还是不该写");
});

test("--mcp-for 能强制写：不想靠探测、或探测不出来时用", async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, "opencode.json"), "{}\n");
  const { code } = await runInit(root, ["--mcp-for", "opencode,cursor"]);
  assert.equal(code, 0);
  assert.match(
    fs.readFileSync(path.join(root, "opencode.json"), "utf8"),
    /devcontrol/,
    "已有的 opencode.json 要被合并进 devcontrol，不是被覆盖",
  );
  assert.ok(fs.existsSync(path.join(root, ".cursor/mcp.json")), "--mcp-for 显式要了就写");
});

test("--mcp-for 写了不认识的名字：报错，不许悄悄忽略", async () => {
  const root = makeRepo();
  const { code, out } = await runInit(root, ["--mcp-for", "vscode"]);
  assert.notEqual(code, 0);
  assert.match(out, /E_INVALID/);
  assert.match(out, /vscode/);
  assert.ok(!fs.existsSync(path.join(root, ".mcp.json")), "参数错就不该动任何配置");
});

test("已经被跟踪的 MCP 配置不翻案：继续跟着一起提交", () => {
  // 团队里有人故意提交了共享配置（比如统一走某个包装脚本），
  // git 对已跟踪文件不会因为后加的 ignore 就停止跟踪，硬来只会造出怪状态。
  const root = makeRepo();
  fs.writeFileSync(path.join(root, ".mcp.json"), '{"mcpServers":{}}\n');
  sh(root, "git", "add", ".mcp.json");
  sh(root, "git", "commit", "-m", "shared mcp config");
  return runInit(root).then(({ code }) => {
    assert.equal(code, 0);
    assert.match(sh(root, "git", "ls-files"), /^\.mcp\.json$/m, "已跟踪的不能被悄悄取消跟踪");
    assert.doesNotMatch(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^\.mcp\.json$/m, "别给已跟踪文件加 ignore，那会变成被跟踪却被忽略");
  });
});
