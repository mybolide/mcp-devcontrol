// devcontrol — 任务标题说人话（机器认的那部分仍在 deriveFrom / acceptance 里）
import test from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "../src/digest.js";
import { humanAssertionTitle } from "../src/title.js";
import { makeRepo, initFlow } from "./helpers.js";

test("常见命令翻成人话", () => {
  const cases = [
    ["cargo clippy --workspace --locked --all-targets -- -D warnings :: exit==0", "Clippy 零告警"],
    ["cargo clippy -p agent-studio-acp --locked -- -D warnings :: exit==0", "agent-studio-acp 的 Clippy 零告警"],
    ["cargo test --workspace --locked :: exit==0", "跑通 Rust 测试（全工作区）"],
    ["cargo test -p agent-studio-ipc --locked :: exit==0", "跑通 agent-studio-ipc 的测试"],
    ["git diff --check :: exit==0", "改动里没有空白错误"],
    ["npm test :: exit==0", "跑通单元测试"],
    ["npm --prefix apps/desktop run build :: exit==0", "构建 apps/desktop"],
    ["node --test docs/spikes/x.test.mjs :: exit==0", "跑通 docs/spikes/x.test.mjs"],
    ["go test ./... :: exit==0", "跑通 Go 测试"],
    ["cargo fmt --all -- --check :: exit==0", "格式检查通过"],
    ["node -e \"process.exit(0)\" :: exit==0", "跑通项目自带的校验脚本"],
  ];
  for (const [assertion, expected] of cases) {
    assert.equal(humanAssertionTitle(assertion), expected, assertion);
  }
});

test("认不出来的命令老实说，不硬编", () => {
  assert.match(humanAssertionTitle("some-tool --weird :: exit==0"), /跑通 some-tool/);
  assert.equal(humanAssertionTitle(""), "补一条验收");
});

test("next 造任务时用这句人话当标题，命令与 deriveFrom 仍然原样存着", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const next = bootstrap(db, root).next;
  assert.equal(next.action, "task.create");
  assert.equal(next.args.title, "跑通单元测试", `标题应当是话不是命令：${next.args.title}`);
  assert.equal(next.args.acceptance[0].assertion, "npm test :: exit==0", "断言本身不许被改写");
  assert.equal(next.args.acceptance[0].deriveFrom, 0);
  db.close();
});