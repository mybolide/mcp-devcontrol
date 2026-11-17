// MCP 下发给 Agent 的规则文本、README 动作表，必须和内核真实行为一致。
//
// 这类"各说一套"没人会当场发现：Agent 读到的是 INSTRUCTIONS 和 SKILL，
// 是 Owner 读到的是 README。三处只要有一处落后一步，照着做就撞墙，
// 而报错信息会把锅甩给"我没按规矩来"。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("INSTRUCTIONS 的收尾顺序必须是 run → commit → close", async () => {
  const { INSTRUCTIONS } = await import("../src/mcp.js");
  const iRun = INSTRUCTIONS.indexOf("devcontrol run --");
  const iCommit = INSTRUCTIONS.indexOf("devcontrol commit");
  const iClose = INSTRUCTIONS.indexOf("task.close");
  assert.ok(iRun >= 0, "漏了「先跑验收」这一步，Agent 只会 commit 完直接 close，然后被 E_NO_EVIDENCE 拦一次才学会");
  assert.ok(iCommit >= 0 && iClose >= 0);
  assert.ok(iRun < iCommit && iCommit < iClose, `顺序错了：${INSTRUCTIONS.slice(0, 400)}`);
});

// 从 ACTIONS 反推正则：不手抄动作名，抄了就会漏
const actionPattern = async () => {
  const { ACTIONS } = await import("../src/mcp.js");
  return { ACTIONS, re: new RegExp(`\\b(?:${ACTIONS.map((a) => a.replace(/\./g, "\\.")).join("|")})\\b`, "g") };
};

// 文本里以 `xxx.yyy` 出现、像是动作的东西：memory.db / npm.test 这类文件名要排除
const looksLikeFile = (tok) => /\.(js|mjs|cjs|db|sqlite|md|json|html|css|txt|log|lock|ts|tsx)$/i.test(tok);
const dottedTokens = (text) => new Set((text.match(/\b[a-z]+[a-z.]*\.[a-z]+\b/g) || []).filter((t) => !looksLikeFile(t)));

test("INSTRUCTIONS 提到的每个动作都在 ACTIONS 里（不教人调非法动作）", async () => {
  const { ACTIONS } = await import("../src/mcp.js");
  const { INSTRUCTIONS } = await import("../src/mcp.js");
  const { re } = await actionPattern();
  const mentioned = new Set(INSTRUCTIONS.match(re) || []);
  assert.ok(mentioned.size >= 5, `解析到的动作太少，正则可能失效了：${[...mentioned]}`);

  // 反向：任何长得像 devcontrol 动作、但不在 ACTIONS 里的写法（比如写成 task.finish）
  const stray = [...dottedTokens(INSTRUCTIONS)].filter(
    (t) => /^(task|evidence|bug|memory|release|req|path)\./.test(t) && !ACTIONS.includes(t),
  );
  assert.deepEqual(stray, [], `INSTRUCTIONS 提到了不存在的动作：${stray.join(", ")}`);
});

test("README 的 MCP 动作表覆盖了每个真实动作，且没有多余的行", async () => {
  const { ACTIONS } = await import("../src/mcp.js");
  const readme = read("../README.md");
  const start = readme.indexOf("MCP 只有一个工具");
  const end = readme.indexOf("CLI 等价", start);
  assert.ok(start >= 0 && end > start, "README 里那节定位不到，测试等于没跑");
  const section = readme.slice(start, end);
  // 表格里动作写成行内代码（`release.create` / `release.plan` / `release.ship` 可能挤在一行），
  // 所以先抓出这一节所有行内代码，再看和 ACTIONS 差在哪
  const inCode = new Set((section.match(/`[^`]+`/g) || []).map((s) => s.slice(1, -1)));
  const missing = ACTIONS.filter((a) => !inCode.has(a));
  assert.deepEqual(missing, [], `README 动作表漏了：${missing.join(", ")}。Owner 或 Agent 翻文档时会以为这些动作不存在`);
  // 反向也要查：长得像动作却不在 ACTIONS 里的写法，照抄就是一发「非法动作」
  const extra = [...inCode].filter((t) => /^(task|evidence|bug|memory|release)\./.test(t) && !ACTIONS.includes(t));
  assert.deepEqual(extra, [], `README 列了代码里没有的动作：${extra.join(", ")}`);
});

test("没有地方再写死动作的个数", () => {
  // 早先 README 写「十四个动作」、src/mcp.js 头部写「13 个动作」，
  // 每加一个动作就漂一次，而没人会去数。数量由 ACTIONS 决定，正文不写死。
  // 注意：别误伤「第一个动作必须是 bootstrap」这种正常的序数用法。
  const files = { "src/mcp.js": read("../src/mcp.js"), "README.md": read("../README.md") };
  for (const [name, body] of Object.entries(files)) {
    assert.doesNotMatch(
      body,
      /\b\d+\s*个动作|十[一二三四五六七八九]?个动作|二十个动作/,
      `${name} 又写死了动作个数；改成"动作用 action 区分"，让 ACTIONS 当唯一事实源`,
    );
  }
});