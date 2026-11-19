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
import { AGENTS_REL, CLAUDE_REL, CURSOR_RULE_REL, SKILL_REL, agentsBlock, claudeBlock, cursorRule, installAgentFiles, skillContent } from "../src/skill.js";
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