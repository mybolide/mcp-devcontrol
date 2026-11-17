// devcontrol — 入口一致性：同一份能力清单，三个入口必须都接上
//
// 为什么值得一组测试：2026-11 的演练里连着撞了三次同一类病——
// 「能能力做出来了，但没接到某个入口上」：
//   · dependsOn 在 MCP 有，CLI 没有 --depends（Agent 用纯 CLI 时表达不了依赖）
//   · 多命令验收数据层支持，控制台表单只收一条（全栈项目构建永远没人跑）
//   · 需求验收能写多条命令，批准时只冻结 Path 采到的那条
// 靠人记「这次别忘了改三处」是记不住的。所以把对应关系写成数据（src/capabilities.js），
// 由这里逐条核对：少接一个入口就红，而且会直接说是哪个入口。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CAPABILITIES, validateTable } from "../src/capabilities.js";
import { ACTIONS, SCHEMA } from "../src/mcp.js";
import { OWNER_ACTIONS } from "../src/console.js";

const SRC = path.join(import.meta.dirname, "..", "src");
const cliSrc = fs.readFileSync(path.join(SRC, "cli.js"), "utf8");

/** 取出某个 CLI 子命令的实现片段（顶层命令取整个 cmd*，分组命令取对应 sub 分支） */
function cliSlice(sub) {
  const TOP = { close: "cmdClose", run: "cmdRun", ask: "cmdAsk", bug: "cmdBug", intake: "cmdIntake", approve: "cmdApprove" };
  const GROUP = { task: "cmdTask", memory: "cmdMemory" };

  const fnBody = (fnName) => {
    const start = cliSrc.search(new RegExp(`export (async )?function ${fnName}\\(`));
    assert.ok(start >= 0, `CLI 里找不到 ${fnName}`);
    const rest = cliSrc.slice(start);
    const endIdx = rest.slice(1).search(/\nexport (async )?function /);
    return endIdx > 0 ? rest.slice(0, endIdx + 1) : rest;
  };

  if (TOP[sub]) return fnBody(TOP[sub]);

  const [group, verb] = sub.split(" ");
  const fnName = GROUP[group];
  assert.ok(fnName, `未支持的 CLI 组：${group}`);
  const body = fnBody(fnName);
  const vStart = body.indexOf(`sub === "${verb}"`);
  assert.ok(vStart >= 0, `${fnName} 里没有 ${verb} 分支`);
  const vEnd = body.indexOf('sub === "', vStart + 10);
  return body.slice(vStart, vEnd > 0 ? vEnd : undefined);
}

test("对照表本身没有自相矛盾", () => {
  assert.deepEqual(validateTable(), []);
});

test("MCP 侧：登记了 action 的能力，zod schema 必须收下它的每个参数", () => {
  for (const c of CAPABILITIES) {
    if (!c.action) continue;
    assert.ok(ACTIONS.includes(c.action), `MCP 的 ACTIONS 里没有 ${c.action}`);
    for (const param of c.mcp) {
      assert.ok(Object.hasOwn(SCHEMA, param), `${c.name}（${c.action}）在 MCP 里缺参数 ${param}`);
    }
  }
});

test("CLI 侧：登记了 cli 的能力，对应子命令必须真的解析这些参数", () => {
  for (const c of CAPABILITIES) {
    if (!c.cli) continue;
    const body = cliSlice(c.cli.sub);
    for (const flag of c.cli.flags) {
      assert.ok(body.includes(`--${flag}`) || body.includes(`"${flag}"`), `${c.name}：CLI 的 ${c.cli.sub} 里没有 --${flag}`);
    }
  }
});

test("控制台侧：登记的 Owner 动作必须真的注册了", () => {
  for (const c of CAPABILITIES) {
    if (!c.console) continue;
    assert.ok(Object.hasOwn(OWNER_ACTIONS, c.console), `${c.name}：控制台没注册动作 ${c.console}`);
  }
});

test("MCP 的每个动作都在对照表里有归属（新动作不能悄悄长出来）", () => {
  const known = new Set(CAPABILITIES.filter((c) => c.action).map((c) => c.action));
  // 这几个不是「能力」，是生命周期动作，单独列出而不是漏掉
  const LIFECYCLE = new Set(["bootstrap", "wait", "task.renew", "bug.report", "ask", "release.create", "release.plan", "release.ship"]);
  const orphans = ACTIONS.filter((a) => !known.has(a) && !LIFECYCLE.has(a));
  assert.deepEqual(orphans, [], `这些 MCP 动作没在 capabilities.js 里登记：${orphans.join(", ")}`);
});

test("控制台的每个动作都在对照表里有归属（新按钮不能悄悄长出来）", () => {
  const known = new Set(CAPABILITIES.filter((c) => c.console).map((c) => c.console));
  const orphans = Object.keys(OWNER_ACTIONS).filter((a) => !known.has(a));
  assert.deepEqual(orphans, [], `这些控制台动作没在 capabilities.js 里登记：${orphans.join(", ")}`);
});

test("依赖能力和多命令验收是显式登记过的（这两条曾经漏接过）", () => {
  const create = CAPABILITIES.find((c) => c.action === "task.create");
  assert.ok(create.mcp.includes("dependsOn"), "MCP 要能表达依赖");
  assert.ok(create.cli.flags.includes("depends"), "CLI 也要能表达依赖");
  // 多命令验收：数据层是数组，控制台用换行分隔
  const retest = CAPABILITIES.find((c) => c.console === "path.retest");
  assert.ok(retest, "重采验收命令要登记");
  assert.equal(retest.action, null, "Owner 的动作不该进 MCP");
});