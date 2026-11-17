// devcontrol — 从零走完一轮，只用命令行
//
// T-104 现场：README 把 `--no-mcp` 写成和 MCP 并列的正式模式。
// 但这条路第 1 步就断了：init 之后 next 只说「等 Owner 收件并批准」，
// 而 CLI 里没有任何收件或批准的命令，status 的 console 也是 null。
// 于是纯 CLI 用户的唯一出路是去读源码、找到 POST /api/owner、自己起控制台。
//
// 这不是「少个入口」，是「一个被公开承诺的模式名义上存在、实际不可用」。
// 所以这里不测单个命令，测**整条链路**：收件 → 批准 → 建 → 领 → 提交 → 证据 → 收口。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, BIN } from "./helpers.js";

function cli(root, ...args) {
  const env = { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "agent" };
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8", env }) };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

/** 只跑 init：不接 MCP，模拟「我只有终端」的项目 */
function soloProject() {
  const root = makeRepo();
  const out = cli(root, "init", "--no-mcp");
  assert.equal(out.code, 0, `init 应当成功：${out.stdout}${out.stderr}`);
  return root;
}

test("init --no-mcp 之后没有 MCP 配置，这是这个模式的意义", () => {
  const root = soloProject();
  assert.ok(!fs.existsSync(path.join(root, ".mcp.json")), "纯 CLI 就不该写 .mcp.json");
  assert.ok(fs.existsSync(path.join(root, ".devcontrol/state.db")), "但库要在");
});

test("完整一轮：收件 → 批准 → 建任务 → 领取 → 提交 → 证据 → 收口，全程不出终端", () => {
  const root = soloProject();

  // ① 收件
  const intake = cli(root, "intake", "把首页标题改成人话", "--accept", "npm test :: exit==0");
  assert.equal(intake.code, 0, intake.stdout + intake.stderr);
  assert.match(intake.stdout, /FR-001 {2}已收件/);

  // ② 批准（冻结契约）
  const approve = cli(root, "approve", "FR-001", "--path", "P-001");
  assert.equal(approve.code, 0, approve.stdout + approve.stderr);
  assert.match(approve.stdout, /已批准/);

  // ③ next 必须给出可执行的命令，而不是一句「等 Owner」
  const n1 = cli(root, "next");
  assert.match(n1.stdout, /task\.create/, `批准之后不该还在等：${n1.stdout}`);
  const cmd1 = n1.stdout.trim().split("\n").pop();
  assert.match(cmd1, /^devcontrol task create /, `最后一行应当能直接粘进终端：${cmd1}`);

  // ④ 照着执行（拆成 argv，不经 shell）
  const runLine = (line) => {
    const argv = line.replace(/^devcontrol /, "").match(/'[^']*'|\S+/g).map((s) => s.replace(/^'|'$/g, ""));
    const out = cli(root, ...argv);
    assert.equal(out.code, 0, `命令失败：${line}\n${out.stdout}${out.stderr}`);
    return out;
  };
  runLine(cmd1);

  const n2 = cli(root, "next");
  const cmd2 = n2.stdout.trim().split("\n").pop();
  assert.match(cmd2, /^devcontrol task claim T-\d+$/);
  runLine(cmd2);

  // ⑤ 写代码、提交、留证据
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 42;\n");
  assert.equal(cli(root, "commit", "-m", "feat: 标题改成人话").code, 0);
  assert.equal(cli(root, "run", "--", "npm test").code, 0);

  // ⑥ 收口：内核只核验证据
  const n3 = cli(root, "next");
  const cmd3 = n3.stdout.trim().split("\n").pop();
  assert.match(cmd3, /^devcontrol close T-\d+$/);
  const closed = runLine(cmd3);
  const payload = JSON.parse(closed.stdout.slice(closed.stdout.indexOf("{")));
  assert.equal(payload.ok, true, `收口应当成功：${closed.stdout}`);
  assert.equal(payload.closedBy, "evidence", "收口靠的是证据");

  // ⑦ 活干完了就说到这，不要凭空催人拆新任务
  const done = cli(root, "next");
  assert.match(done.stdout, /^wait/);
  assert.doesNotMatch(done.stdout, /task\.create/, "没有缺口时不该再让人建任务");
});

test("intake 不收没有验收的需求——没有可观测断言的「需求」是许愿", () => {
  const root = soloProject();
  const out = cli(root, "intake", "做得好看点");
  assert.equal(out.code, 2);
  assert.match(out.stdout + out.stderr, /--accept|E_USAGE/);
});

test("intake 的断言语法写错了：说清「有哪几种谓词」，别只说缺 ::", () => {
  const root = soloProject();
  const out = cli(root, "intake", "标题", "--accept", "npm test");
  assert.notEqual(out.code, 0);
  assert.match(out.stdout + out.stderr, /exit==0|stdout =~/, `要告诉人谓词怎么写：${out.stdout}${out.stderr}`);
});

test("approve 缺参数时，把「待批准的需求」和「可用 Path」直接摆出来", () => {
  const root = soloProject();
  cli(root, "intake", "标题", "--accept", "npm test :: exit==0");
  const out = cli(root, "approve");
  assert.equal(out.code, 2);
  assert.match(out.stdout + out.stderr, /FR-001/, `要列出待批准的需求：${out.stdout}${out.stderr}`);
  assert.match(out.stdout + out.stderr, /P-001/, "要列出可用 Path");
});

test("approve 的路径：批准后契约真的进 git，Agent 改不动它", () => {
  const root = soloProject();
  cli(root, "intake", "标题", "--accept", "npm test :: exit==0");
  cli(root, "approve", "FR-001", "--path", "P-001");
  const log = execFileSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" });
  assert.match(log, /chore\(devcontrol\): approve/, `契约要被提交进仓库：${log}`);
  const contracts = fs.readdirSync(path.join(root, ".devcontrol/contracts"));
  assert.ok(contracts.length >= 1, "契约文件要落盘");
});

test("谁批准的要查得到：终端批准记 channel=cli，不是冒充控制台点的", () => {
  const root = soloProject();
  cli(root, "intake", "标题", "--accept", "npm test :: exit==0");
  cli(root, "approve", "FR-001", "--path", "P-001");
  const rows = execFileSync(
    "sqlite3",
    [path.join(root, ".devcontrol/state.db"), "select channel||'|'||action from events where action like 'req.%' order by id"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  assert.deepEqual(rows, ["cli|req.intake", "cli|req.approve"], `事件要记来自终端：${JSON.stringify(rows)}`);
});

test("能力对照表：收件和批准都登记了 CLI 入口", async () => {
  const { CAPABILITIES } = await import("../src/capabilities.js");
  const intake = CAPABILITIES.find((c) => c.console === "intake");
  const approve = CAPABILITIES.find((c) => c.console === "approve");
  assert.ok(intake, "对照表里找不到 intake 这条能力");
  assert.ok(intake?.cli, "收件要有 CLI 入口——纯 CLI 模式的第一步就是它");
  assert.ok(approve?.cli, "批准也要有，否则收进来的需求永远批不了");
  assert.match(intake.cli.sub, /^intake/);
  assert.match(approve.cli.sub, /^approve/);
});

test("卡在「没批准」时，blocker 给的是能敲的命令，不是一句「等 Owner」", () => {
  // 评审的实测现场：next 说等 Owner、blockers 说等 Owner、console 是 null——
  // 三条路全断了，而 fix 文本连「去起控制台」都没写（T-104）。
  const root = soloProject();
  const out = cli(root, "status");
  const digest = JSON.parse(out.stdout.slice(out.stdout.indexOf("{")));
  const blocker = digest.blockers.find((b) => b.code === "E_NEED_APPROVED");
  assert.ok(blocker, `应当报 E_NEED_APPROVED：${out.stdout}`);
  assert.match(blocker.fix, /devcontrol (intake|approve|init)/, `fix 里要有可执行的命令：${blocker.fix}`);
  assert.match(digest.next.why, /intake|approve|控制台/, `next.why 同样要给出路：${digest.next.why}`);
});

test("收件 + 批准之后，blocker 消失（不是永远挂着一句等 Owner）", () => {
  const root = soloProject();
  cli(root, "intake", "标题", "--accept", "npm test :: exit==0");
  cli(root, "approve", "FR-001", "--path", "P-001");
  const out = cli(root, "status");
  const digest = JSON.parse(out.stdout.slice(out.stdout.indexOf("{")));
  assert.equal(digest.blockers.filter((b) => b.code === "E_NEED_APPROVED").length, 0);
});
