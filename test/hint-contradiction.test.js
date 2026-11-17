// 报错提示得站得住：①不能自相矛盾 ②不能盖掉更有用的那句 ③不能把人带错方向。
//
// 两起真实踩坑（都是黑盒实测里撞出来的，不是想出来的）：
//  · `devcontrol close` 没提交时，报 E_NO_DELIVERY，提示只有一句
//    "devcontrol commit -m ..." —— 照做就先提交了没验证过的代码，
//    而 hints.js 里明明写着完整四步（写 → run → commit → close）。
//    根因是 gates.js 自己塞了一句半截 hint，被当成"更具体的提示"优先采用。
//  · `devcontrol approve` 少给 --path 时，明明命令形状是对的，
//    却补一句"命令写错了，看 --help"——人只会去翻帮助，而不是补参数。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { BIN, makeRepo } from "./helpers.js";

const run = (cwd, args) => {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

test("hints.js 里 E_NO_DELIVERY 的说明是完整四步，且顺序是 run → commit → close", async () => {
  const { hintFor } = await import("../src/hints.js");
  const hint = hintFor({ code: "E_NO_DELIVERY" });
  assert.ok(hint.indexOf("devcontrol run --") >= 0, "漏了 run，人就只剩 commit 一条路");
  assert.ok(hint.indexOf("devcontrol run --") < hint.indexOf("commit"), `顺序错了：${hint}`);
  assert.ok(hint.indexOf("commit") < hint.indexOf("close"), `顺序错了：${hint}`);
});

test("gates.js 不再自己塞半截 hint 盖掉完整说明", async () => {
  // 这条是防回归：半截 hint 一旦回来，上面那条测试仍然是绿的
  // （hints.js 没变），但用户看到的就是被盖掉之后那句。
  const src = fs.readFileSync(new URL("../src/gates.js", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.includes('fail("E_NO_DELIVERY"'));
  assert.ok(line, "找不到抛 E_NO_DELIVERY 的地方，测试可能失效了");
  assert.doesNotMatch(line, /hint:/, "这里别给 hint：会盖掉 hints.js 里那条完整说明");
});

test("close 没提交时：人看到的是完整四步，不是一句 commit", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  run(root, ["intake", "close 提示", "--accept", "npm test :: exit==0"]);
  run(root, ["approve", "FR-001", "--path", "P-001"]);
  run(root, ["task", "create", "--req", "FR-001", "--path", "P-001", "--title", "t", "--scope", "src", "--accept", "npm test :: exit==0"]);
  run(root, ["task", "claim", "T-001"]);

  const out = run(root, ["close", "T-001"]);
  assert.notEqual(out.code, 0);
  assert.match(out.stderr, /E_NO_DELIVERY/);
  assert.match(out.stderr, /devcontrol run --/, "提示里必须有「先跑」这一步");
  assert.ok(out.stderr.indexOf("run --") < out.stderr.indexOf("commit"), `stderr 上的顺序也得对：${out.stderr}`);
});

test("approve 少给 --path：给的是照抄就能过的命令，不是「命令写错了」", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  run(root, ["intake", "approve 提示", "--accept", "npm test :: exit==0"]);

  const out = run(root, ["approve"]);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /待批准的需求：FR-001/, "得说清有哪些待批的");
  assert.match(out.stderr, /可用 Path：P-001/, "得说清能用哪个 Path");
  assert.match(out.stderr, /照抄这条：devcontrol approve FR-001 --path P-001/, "直接给一条能过的命令");
  assert.doesNotMatch(out.stderr, /命令写错了/, "命令形状是对的，只是缺参数——别把人往 --help 上引");
});

test("approve 的示例命令真的能跑通（提示不是编的）", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  run(root, ["intake", "示例可执行", "--accept", "npm test :: exit==0"]);

  const hintLine = run(root, ["approve"]).stderr.split("\n").find((l) => l.includes("照抄这条："));
  assert.ok(hintLine, "没给示例");
  const cmd = hintLine.split("照抄这条：")[1].trim();
  const [bin, ...args] = cmd.split(/\s+/);
  assert.equal(bin, "devcontrol");
  const out = run(root, args);
  assert.equal(out.code, 0, `提示里那条命令跑不过：${cmd}\n${out.stderr}`);
  assert.match(out.stdout, /已批准/);
});

test("没有待批需求时，approve 说清下一步该做什么", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  const out = run(root, ["approve"]);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /devcontrol intake/, "空手时该告诉人先收一条");
  assert.doesNotMatch(out.stderr, /照抄这条/, "没有可用需求时别硬编一条命令");
});
