// 纯 CLI 模式：每一步都得能看见"下一条命令"，而且那条命令敲下去就过。
//
// 这条链上每一步单独看都很小，但缺任何一环，纯 CLI 模式就断在那一步：
// 没有需求 → 收了件 → 「等 Owner 批准」却没有 approve 命令 → 走到这里人只能去翻源码。
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

const next = (root) => JSON.parse(run(root, ["status"]).stdout).next;

// 照抄内核给的命令行，真的跑一遍——"给了命令"和"命令能跑"是两件事。
// 必须交给 shell 跑：命令里带引号（任务标题含空格），自己按空白拆会拆坏，
// 那样测出来的失败是夹具的锅，不是内核的（这正是上一版报错的原因）。
const followCli = (root, cli) => {
  assert.ok(cli, "这一步没给命令，纯 CLI 就断在这里了");
  assert.match(cli, /^devcontrol /, `next.cli 该是能直接敲的 devcontrol 命令：${cli}`);
  const cmd = cli.replace(/^devcontrol /, `"${process.execPath}" "${BIN}" `);
  try {
    const stdout = execFileSync("sh", ["-c", cmd], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

test("有待批准需求时，next 直接给出 approve 命令（不只说「等 Owner」）", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  run(root, ["intake", "加个函数", "--accept", "npm test :: exit==0"]);

  const n = next(root);
  assert.equal(n.action, "wait", "批准是人的动作，内核这里不能替人做");
  assert.match(n.cli ?? "", /^devcontrol approve FR-001 --path P-0\d+$/, `该给的就是这条：${n.cli}`);
  assert.match(n.why, /FR-001/, "why 里要说清是哪条需求");
});

test("next 给的那条 approve 命令，敲下去真的过", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);
  run(root, ["intake", "加个函数", "--accept", "npm test :: exit==0"]);

  const out = followCli(root, next(root).cli);
  assert.equal(out.code, 0, `照抄都不做，人还能怎么办：${out.stderr}`);
  assert.match(out.stdout, /已批准/);
  // 批准之后立刻要能走到下一步（拆任务），不能又卡回「等」
  assert.equal(next(root).action, "task.create");
});

test("还没有需求时，next 给出的是 intake 的写法，而不是 approve", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);

  const n = next(root);
  assert.equal(n.action, "wait");
  assert.match(n.why, /devcontrol intake/, "空手时要用哪条命令开局，得说出来");
});

test("整条链一次走完：intake → approve → create → claim → run → commit → close", () => {
  const root = makeRepo();
  run(root, ["init", "--no-mcp"]);

  // ① 收件（这条还没有 cli，why 里写着形状）
  run(root, ["intake", "加个函数", "--accept", "npm test :: exit==0"]);

  // ② 批准：照 next.cli
  assert.equal(followCli(root, next(root).cli).code, 0);

  // ③ 拆任务：照 next.cli
  assert.equal(next(root).action, "task.create");
  assert.equal(followCli(root, next(root).cli).code, 0);

  // ④ 领取
  assert.equal(next(root).action, "task.claim");
  assert.equal(followCli(root, next(root).cli).code, 0);

  // ⑤ 领了活，next 必须给"该你干活"而不是直接催收口
  const working = next(root);
  assert.equal(working.action, "task.work");
  assert.ok(working.steps.some((s) => s.includes("devcontrol run --")));

  // ⑥ 写 + 跑 + 提交 + 收口
  fs.writeFileSync(`${root}/src/b.js`, "export const b = 2;\n");
  assert.equal(run(root, ["run", "--", "npm", "test"]).code, 0);
  assert.equal(run(root, ["commit", "-m", "feat: add b"]).code, 0);
  const closed = run(root, ["close", "T-001"]);
  assert.equal(closed.code, 0, `收口失败：${closed.stderr}`);
  assert.match(closed.stdout, /"closedBy": "evidence"/);
});
