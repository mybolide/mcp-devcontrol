// devcontrol — next 给的命令必须真的能执行
//
// T-102 现场：SKILL 写着「按 next.args 原样执行（参数是给全的）」，
// 但纯 CLI 用户拿到的是一坨 JSON：requirementId、pathId、acceptance……
// CLI 那边叫 --req / --path / --accept。这等于给了原料，没给饭。
//
// 所以这里不只断言字符串长得对，而是把生成出来的命令**真的丢给 shell 跑一遍**。
// 一个「看起来能跑」的命令，是这个产品最不该有的东西。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, initFlow, newTask, BIN } from "./helpers.js";
import { bootstrap } from "../src/digest.js";
import { cliCommand, quote } from "../src/nextcmd.js";
import { openDb } from "../src/db.js";
import { listTasks } from "../src/store.js";

/** 在项目里执行一行 next 命令（拆成 argv，不经 shell：测的是命令本身，不是 shell） */
function runLine(root, line) {
  // next 给的引号按平台不同（POSIX 单引号、Windows 双引号），这里用一个最小的切分器
  // 还原参数：两种引号都支持，不做变量展开——测的是命令本身，不是 shell。
  const argv = [];
  let cur = "";
  let quoteChar = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoteChar) {
      if (c === quoteChar) quoteChar = null;
      else cur += c;
    } else if (c === "'" || c === '"') quoteChar = c;
    else if (c === " ") {
      if (cur) argv.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) argv.push(cur);
  assert.equal(argv[0], "devcontrol", `命令必须以 devcontrol 开头：${line}`);
  return execFileSync(process.execPath, [BIN, ...argv.slice(1)], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "agent" },
  });
}

test("建任务：next 给的那行命令真的能在项目里建出任务", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const next = bootstrap(db, root).next;

  assert.equal(next.action, "task.create");
  assert.ok(next.cli, "纯 CLI 用户要的是命令行，不是 JSON");
  assert.match(next.cli, /^devcontrol task create /);
  assert.match(next.cli, /--req FR-001/, "需求号要翻成 --req");
  assert.match(next.cli, /--path P-001/, "Path 号要翻成 --path");
  assert.ok(!next.cli.includes("requirementId"), "别把 MCP 的参数名漏到命令行里");

  runLine(root, next.cli);
  const tasks = listTasks(openDb(root));
  assert.equal(tasks.length, 1, "命令跑完了就必须真的有一条任务");
  assert.equal(tasks[0].delivery, "code", "自动补齐的验收覆盖任务可能需要实现，默认必须保留 code");
});

test("显式 verify 交付模式会进入 next CLI 命令，执行后仍是 verify", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const line = cliCommand("task.create", {
    requirementId: reqId,
    pathId: "P-001",
    kind: "test",
    delivery: "verify",
    title: "只运行冻结验收",
    scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });

  assert.match(line, /--kind test/);
  assert.match(line, /--delivery verify/);
  runLine(root, line);
  const [task] = listTasks(openDb(root));
  assert.equal(task.kind, "test");
  assert.equal(task.delivery, "verify");
});

test("领任务 / 收口：命令同样是可执行的", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  newTask(db, root, reqId);

  const a = bootstrap(db, root).next;
  assert.equal(a.action, "task.claim");
  assert.equal(a.cli, `devcontrol task claim ${a.args.id}`);
  runLine(root, a.cli);

  // 领完还没写码：不给一条「照抄必挂」的 close，而是给步骤
  const b = bootstrap(db, root).next;
  assert.equal(b.action, "task.work");
  assert.equal(b.cli, null, "这一步没有单条命令可给，就不要编一条");
  assert.ok(b.steps?.length, `要给步骤：${JSON.stringify(b)}`);
});

test("带空格和中文的标题被引号包住，不会被 shell 拆散", () => {
  const line = cliCommand("task.create", {
    requirementId: "FR-1",
    pathId: "P-1",
    title: "周报：把事件流变成人能读的东西",
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  // 引号形式按平台不同（cmd.exe 不认单引号），所以期望值也从 quote() 取，不写死
  assert.ok(line.includes(quote("周报：把事件流变成人能读的东西")), line);
  assert.ok(line.includes(quote("npm test :: exit==0")), "断言里的空格和 :: 也要保住");
});

test("quote 只管引号，不改内容：标题里的单引号也得活着", () => {
  assert.equal(quote("plain"), "plain", "没有特殊字符就别加引号");
  // 去掉外层引号 + 还原转义后，必须原样等于输入：「加引号」不等于「改内容」
  const strip = (v) => {
    if (v.startsWith('"')) return v.slice(1, -1);
    return v.slice(1, -1).split("'\\''").join("'");
  };
  assert.equal(strip(quote("it's fine")), "it's fine");
  assert.equal(strip(quote("has space")), "has space");
});

test("不认识的 action 就返回 null——宁可不说，也不编一条跑不通的命令", () => {
  assert.equal(cliCommand("release.ship", { id: "R-001" }), null);
  assert.equal(cliCommand("wait", {}), null);
  assert.equal(cliCommand("task.claim", {}), null, "缺 id 时不能编一个空参数的命令");
});

test("wait 时没有命令可给：只说等什么，不假装有活干", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  // 没有待办、没有缺口 → wait
  const d = bootstrap(db, root);
  if (d.next.action === "wait") {
    assert.equal(d.next.args && Object.keys(d.next.args).length, 0);
    assert.equal(d.next.cli, null);
  }
});

test("SKILL 里那句「原样执行」对着 cli 字段仍然成立", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const next = bootstrap(db, root).next;
  runLine(root, next.cli);
  const dir = path.join(root, ".devcontrol");
  assert.ok(fs.existsSync(path.join(dir, "state.db")));
});