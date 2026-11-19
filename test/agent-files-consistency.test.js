// 四个下发文件必须说同一套话（T-144）。
//
// 背景：真实事故——`claudeBlock()` 写的是「改完 commit → run 留证据 → close」，
// 而 `skillBody()` 写的是「run → commit → close」（T-107/T-108 定的唯一顺序）。
// 两个文件说相反的话：Claude Code 用户读 CLAUDE.md 就学到错顺序。
//
// 这就是「串了」：规矩本身不一致，Agent 读哪个文件决定了它守哪套。
// 而且四个文件都没有版本号——升级后没人知道装的是新的还是旧的。
//
// 所以这条测试盯三件事：
//   ① 版本号：四个文件都必须带，且等于当前 VERSION
//   ② 顺序：不许出现 commit 在 run 之前
//   ③ 关键动作：claim / run / commit / close / 项目上下文，四个文件都得提到
import test from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/protocol.js";
import { makeRepo } from "./helpers.js";
import { AGENTS_REL, CLAUDE_REL, CURSOR_RULE_REL, SKILL_REL, agentsBlock, claudeBlock, cursorRule, installAgentFiles, skillContent } from "../src/skill.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 四个下发物：名字 → 内容（SKILL 用 skillContent，因为版本号在 frontmatter 里） */
const files = () => ({
  [SKILL_REL]: skillContent({}),
  [AGENTS_REL]: agentsBlock(),
  [CLAUDE_REL]: claudeBlock(),
  [CURSOR_RULE_REL]: cursorRule(),
});

test("四个下发文件都带版本号，且等于当前 VERSION", () => {
  for (const [name, body] of Object.entries(files())) {
    assert.ok(
      body.includes(VERSION),
      `${name} 里没有版本号 ${VERSION}——用户看不出装的是哪一版，升级后也无法判断新旧`,
    );
  }
});

test("不许出现「commit 在 run 之前」——顺序只有一套：run → commit → close", () => {
  for (const [name, body] of Object.entries(files())) {
    const r = body.indexOf("run");
    const c = body.indexOf("commit");
    if (r < 0 || c < 0) continue; // 没提这两个动作的文件另由下一条管
    assert.ok(
      r < c,
      `${name} 把 commit 写在了 run 前面（run@${r} vs commit@${c}）——这会让 Agent 先提交再跑，证据链断掉`,
    );
  }
});

test("四个下发文件都必须提到 claim / run / commit / close", () => {
  for (const [name, body] of Object.entries(files())) {
    for (const action of ["claim", "run", "commit", "close"]) {
      assert.match(body, new RegExp(action, "i"), `${name} 没提 ${action}——Agent 读它就学不到这一步`);
    }
  }
});

test("四个下发文件都要说清「claim 的返回值带着项目上下文」", () => {
  for (const [name, body] of Object.entries(files())) {
    // 允许「这个项目的上下文」「项目上下文」两种写法
    assert.match(body, /(这个)?项目(的)?上下文/, `${name} 没提项目上下文——Agent 会自己重新摸索一遍项目`);
  }
});

test("安装到真实目录后：四个文件各自落地，且版本号写进去了", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dc-agentfiles-"));
  // 让 usesClaude / usesCursor 都命中，四个文件才会全装
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "");
  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });

  const status = installAgentFiles(root, { noMcp: true });
  for (const rel of [SKILL_REL, AGENTS_REL, CLAUDE_REL, CURSOR_RULE_REL]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} 该被装出来`);
    assert.ok(status[rel], `${rel} 该有状态`);
    assert.ok(fs.readFileSync(path.join(root, rel), "utf8").includes(VERSION), `${rel} 落地后要带版本号`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("升级场景：旧版本的 AGENTS 块会被整块替换，不残留两套规矩", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dc-upgrade-"));
  fs.mkdirSync(path.join(root, ".agents", "skills", "devcontrol"), { recursive: true });
  // 模拟上一版装的内容：旧版本号 + 错的顺序 + 用户自己写的内容
  const old = [
    "用户自己写的注意事项",
    "<!-- devcontrol:begin — 自动生成，勿手改；版本 0.0.1-alpha -->",
    "改完 commit → run 留证据 → close。",
    "<!-- devcontrol:end -->",
    "用户写在后面的东西",
  ].join("\n");
  fs.writeFileSync(path.join(root, AGENTS_REL), old);

  installAgentFiles(root, { noMcp: true });
  const after = fs.readFileSync(path.join(root, AGENTS_REL), "utf8");

  assert.ok(after.includes(VERSION), `新版号要写进去：${after.slice(0, 200)}`);
  assert.doesNotMatch(after, /0\.0\.1-alpha/, "旧版本号不许残留——残留就说明有两块，规矩串了");
  assert.doesNotMatch(after, /commit → run/, "旧顺序不许残留");
  assert.equal((after.match(/devcontrol:begin/g) ?? []).length, 1, "只许有一个 devcontrol 块");
  // 用户自己的内容必须保留
  assert.match(after, /用户自己写的注意事项/, "不许吞用户内容");
  assert.match(after, /用户写在后面的东西/, "不许吞用户内容");
  fs.rmSync(root, { recursive: true, force: true });
});

// ── T-146：收口之后补托管文件 ─────────────────────────────────────────────
//
// 场景：开发期间装了新客户端（比如 Cursor）。MCP 连上时那条重扫因为「有在办任务」被跳过
// （怕弄脏工作树、卡住 commit/close），所以只能靠 close 之后补。
//
// 踩到的坑：close 里补完要提交，而那个提交没有 Task-Id。**串行时看不出来**——
// 第二个任务的 base_head 已经包含它；只有并行时（另一个任务已在办、基线已定）
// 它才落进别人的收口区间，被当成「无主提交」拦死。所以这条必须用并行场景验。
test("收口后补托管文件并提交，且那个提交不毒害另一个在办任务", async () => {
  const { initFlow, newTask, prove } = await import("./helpers.js");
  const { openDb } = await import("../src/db.js");
  const { taskClaim, taskClose } = await import("../src/gates.js");
  const { commitFiles } = await import("../src/git.js");
  const { getTask } = await import("../src/store.js");

  const root = makeRepo();
  const { db, reqId } = initFlow(root, { allowed: ["src", "test"] });
  const a = newTask(db, root, reqId, { title: "甲", scope: ["src/a", "test"] });
  const b = newTask(db, root, reqId, { title: "乙", scope: ["src/b", "test"] });
  // 两个任务同时领走：b 的 base_head 就此定死
  taskClaim(db, root, { id: a.id }, "agent-1");
  taskClaim(db, root, { id: b.id }, "agent-2");

  // 干活期间装了 Cursor（这正是 MCP 那条路补不到、只能 close 补的场景）
  fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/a"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/b"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/a/x.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(root, "src/b/y.js"), "export const y = 2;\n");
  commitFiles(root, ["src/a/x.js"], `feat\n\nTask-Id: ${a.id}`, { author: "agent-1" });
  commitFiles(root, ["src/b/y.js"], `feat\n\nTask-Id: ${b.id}`, { author: "agent-2" });
  prove(db, root, a.id);
  prove(db, root, b.id);

  // 甲先收口：这会顺手补 .cursor 指针并提交一个 chore 提交
  await taskClose(db, root, { id: a.id });
  assert.ok(
    fs.existsSync(path.join(root, ".cursor", "rules", "devcontrol.mdc")),
    "收口后要补 .cursor/rules/devcontrol.mdc——否则装了 Cursor 也读不到规矩",
  );
  assert.match(
    spawnSyncG(root, ["log", "--oneline"]),
    /同步 Agent 说明/,
    "补完要提交，别留脏工作树",
  );

  // 乙收口：那个 chore 提交落在乙的区间里，必须被认成内核提交，不能算无主
  await assert.doesNotReject(
    () => taskClose(db, root, { id: b.id }),
    "另一个任务的托管提交被当成了无主提交（E_UNOWNED_COMMIT）",
  );
  assert.equal(getTask(db, b.id).status, "done");
});

/** 在仓库里跑 git，返回 stdout */
function spawnSyncG(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout ?? "";
}
