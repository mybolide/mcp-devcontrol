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

test("init 不把 MCP 配置提交进仓库：里面是本机绝对路径，clone 下来就是死的", () => {
  // 公开仓库踩到的：.mcp.json 里写着 /Users/<某人>/.../node 和 .../devcontrol.js，
  // 三个客户端配置全都推上去了。别人 clone 下来得到一份指向别人机器的死配置，
  // 顺带把作者的主目录结构也印在公网上。
  const root = makeRepo();
  return runInit(root).then(({ code }) => {
    assert.equal(code, 0);
    // 文件该在磁盘上——本机自己要用
    for (const f of [".mcp.json", ".cursor/mcp.json", "opencode.json"]) {
      assert.ok(fs.existsSync(path.join(root, f)), `${f} 该被写出来`);
    }
    // 但不该被 git 跟踪
    const tracked = sh(root, "git", "ls-files").split("\n");
    for (const f of [".mcp.json", ".cursor/mcp.json", "opencode.json"]) {
      assert.ok(!tracked.includes(f), `${f} 不该提交（里面是本机路径）`);
    }
    // 也不能因此变成一条天天挂着的 ?? —— 那就只是把问题挪了个地方
    const status = sh(root, "git", "status", "--porcelain").trim();
    assert.equal(status, "", `init 之后工作树该干净，实际有：\n${status}`);
  });
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
