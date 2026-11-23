// 两个内核缺陷的回归：目录通配符 scope、验收子进程的 Rustup 环境。
//
// 两者在 Agent Studio 的真实开发里都能把人卡死：
//   · `crates/x/**` 被当成字面路径，目录里的文件全被判 E_SCOPE_VIOLATION；
//   · `devcontrol run -- cargo test` 因为丢了 RUSTUP_HOME 报「could not choose a version of cargo」，
//     而同一个命令在终端里是通的——证据永远出不来。
import test from "node:test";
import assert from "node:assert/strict";
import { inScope } from "../src/fingerprint.js";
import { buildEnv } from "../src/exec.js";

const crate = ["crates/agent-studio-protocol/**"];

test("scope 的目录通配符 **：覆盖该目录下的文件与各级子目录", () => {
  for (const f of [
    "crates/agent-studio-protocol/Cargo.toml",
    "crates/agent-studio-protocol/src/lib.rs",
    "crates/agent-studio-protocol/src/deep/nested/mod.rs",
  ]) {
    assert.equal(inScope(f, crate), true, `${f} 应该在自己的目录通配符范围内`);
  }
});

test("scope 的 ** 不吃相似前缀：foo/** 不匹配 foo-bar", () => {
  assert.equal(inScope("crates/agent-studio-protocol-api/src/lib.rs", crate), false);
  assert.equal(inScope("crates/agent-studio-protocolx/Cargo.toml", crate), false);
});

test("精确文件路径与目录前缀匹配保持原样", () => {
  assert.equal(inScope("src/a.js", ["src/a.js"]), true);
  assert.equal(inScope("src/a.js", ["src"]), true, "目录前缀覆盖其下文件");
  assert.equal(inScope("src/a.js", ["src/a"]), false, "前缀必须按路径段对齐");
  assert.equal(inScope("docs/a.md", ["src"]), false);
});

test("越权路径仍然被拒：不能靠通配符顺手放开别处", () => {
  for (const f of ["../outside", "crates/other/Cargo.toml", "docs/readme.md"]) {
    assert.equal(inScope(f, crate), false, `${f} 不在范围内`);
  }
});

test("裸 ** 与 . 等价：整个仓库，但排除内核自己的 .devcontrol", () => {
  assert.equal(inScope("anywhere/x.txt", ["**"]), true);
  assert.equal(inScope(".devcontrol/state.db", ["**"]), false);
  assert.equal(inScope(".devcontrol/state.db", ["."]), false);
});

test("验收子进程环境：带 Rustup/Cargo 定位变量，但不继承密钥", () => {
  const backup = {};
  for (const k of ["RUSTUP_HOME", "CARGO_HOME", "AWS_SECRET_ACCESS_KEY"]) backup[k] = process.env[k];
  try {
    process.env.RUSTUP_HOME = "C:/Users/x/.rustup";
    process.env.CARGO_HOME = "C:/Users/x/.cargo";
    process.env.AWS_SECRET_ACCESS_KEY = "should-not-leak";
    const env = buildEnv();
    assert.equal(env.RUSTUP_HOME, "C:/Users/x/.rustup", "rustup 找不到 home 就选不出工具链");
    assert.equal(env.CARGO_HOME, "C:/Users/x/.cargo");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, "白名单不变：密钥不许透传给测试脚本");
    assert.equal(env.CI, "1");
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});