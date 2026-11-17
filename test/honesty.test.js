// devcontrol — 内核说的话必须是真的
//
// T-075 把 close 改成「不跑测试，只核验证据」之后，文案、文档、甚至下发给 Agent
// 的规则都还写着「内核会在干净检出里重跑验收」。这不是措辞问题：
// mcp.js 那句话会让 Agent 以为不必自己跑测试——而「证据可信」是这个产品唯一的价值。
//
// 所以这组测试守的不是实现，是**说法**。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, initFlow, newTask, closeProven } from "./helpers.js";

const ROOT = path.join(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const read = (p) => fs.readFileSync(p, "utf8");
const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith(".js"));

test("没有哪个源文件还说「干净检出」——内核从不执行你的测试", () => {
  for (const f of srcFiles) {
    const body = read(path.join(SRC, f));
    assert.doesNotMatch(body, /干净检出/, `src/${f} 还在声称内核会重跑`);
  }
});

test("没有哪个源文件还引用 r2-wt（那个目录早就不存在了）", () => {
  for (const f of srcFiles) {
    assert.doesNotMatch(read(path.join(SRC, f)), /r2-wt/, `src/${f} 还在引用 r2-wt`);
  }
});

test("下发给 Agent 的规则里不能有「内核重跑验收」", () => {
  const mcp = read(path.join(SRC, "mcp.js"));
  assert.doesNotMatch(mcp, /重跑验收|干净检出/, "MCP 的 INSTRUCTIONS 会直接被 Agent 读到");
  assert.doesNotMatch(mcp, /reruns acceptance/, "英文描述同理");
  assert.match(mcp, /核验你留下的证据|never runs your tests/, "必须明确说清楚它只核验");
});

test("hints 里不留死键：指向已删除机制的提示只会误导", () => {
  const hints = read(path.join(SRC, "hints.js"));
  for (const dead of ["E_EVIDENCE_DRIFT", "E_NO_CLEAN_WORKTREE"]) {
    assert.doesNotMatch(hints, new RegExp(`^\\s*${dead}:`, "m"), `${dead} 对应的机制已经没了`);
  }
});

test("hints 里同一个错误码不许写两遍（后一条会静默盖掉前一条）", () => {
  const hints = read(path.join(SRC, "hints.js"));
  const keys = [...hints.matchAll(/^\s{2}(E_[A-Z_]+):/gm)].map((m) => m[1]);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dup, [], `重复的键：${dup.join("、")}`);
});

test("README 和页面也不许再许下不存在的承诺", () => {
  for (const rel of ["README.md", "public/index.html"]) {
    const body = read(path.join(ROOT, rel));
    assert.doesNotMatch(body, /r2-wt/, `${rel} 还引用 r2-wt`);
    assert.doesNotMatch(body, /重跑验收|干净检出重跑/, `${rel} 还在说内核重跑`);
  }
});

test("收口真的返回 closedBy=evidence，不是编出来的 rerun", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/a.js"] });
  const fsx = await import("node:fs");
  fsx.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");
  const { commitFiles } = await import("../src/git.js");
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${t.id}`, { author: "agent-x" });

  const { taskClaim } = await import("../src/gates.js");
  taskClaim(db, root, { id: t.id }, "agent-x");
  const out = await closeProven(db, root, { id: t.id });

  assert.equal(out.closedBy, "evidence", "收口靠的是证据，不是一次不存在的重跑");
  assert.equal(db.prepare("SELECT closed_by FROM tasks WHERE id=?").get(t.id).closed_by, "evidence");
});

test("没人再说「Owner 的动作只在控制台」——加了 CLI 入口之后这话就不准了", () => {
  // T-106：T-104 给了 intake/approve 终端入口，但 SKILL、hints、契约文档里
  // 十几处还写着「仅控制台」。这类话最坏的地方不是错，是它会让人（和 Agent）
  // 在纯 CLI 项目里以为这条路不存在——正好是 T-104 修掉的那个死胡同。
  const files = [
    path.join(SRC, "hints.js"),
    path.join(ROOT, "docs/03-discipline-core.md"),
    path.join(ROOT, "README.md"),
    path.join(ROOT, "AGENTS.md"),
  ].filter((f) => fs.existsSync(f));
  for (const f of files) {
    const body = read(f);
    assert.doesNotMatch(body, /仅控制台/, `${path.relative(ROOT, f)} 还说 Owner 动作「仅控制台」`);
    assert.doesNotMatch(body, /只在控制台（\\`devcontrol serve\\`）里，由人点/, `${path.relative(ROOT, f)} 的说明已经过时`);
  }
});

test("SKILL 里两条路都写明：控制台点，或者终端 approve", () => {
  const skill = read(path.join(SRC, "skill.js"));
  assert.match(skill, /devcontrol approve/, "得告诉 Agent：人也可以在终端批准");
  assert.match(skill, /控制台/, "控制台那条路当然还在");
});
