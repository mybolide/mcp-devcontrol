// devcontrol — 项目内版本锁入口（.devcontrol/bin/）
//
// 这层壳的存在理由很具体：客户端掉了 MCP 工具、项目本来就走纯 CLI、或者 CI 里
// 机器上根本没装 devcontrol。三种场景下如果只能写「去跑 devcontrol」，实际跑的
// 是哪一份、哪个版本没人说得清。所以这里验的是「壳在、壳锁版本、壳敲下去能通」。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BIN, makeRepo } from "./helpers.js";
import { VERSION } from "../src/protocol.js";
import { WRAPPER_DIR, WRAPPER_FILES, writeWrappers } from "../src/wrapper.js";

const init = (root) => {
  execFileSync(process.execPath, [BIN, "init", "--no-mcp"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

const wrapperPath = (root, name) => path.join(root, WRAPPER_DIR, name);

test("init 在项目里落三个平台的入口壳，且版本写死在里面", () => {
  const root = makeRepo();
  init(root);
  for (const name of WRAPPER_FILES) {
    const abs = wrapperPath(root, name);
    assert.ok(fs.existsSync(abs), `${name} 没落盘：纯 CLI 项目就少了一条不依赖全局安装的路`);
    const body = fs.readFileSync(abs, "utf8");
    assert.match(body, new RegExp(`devcontrol-cli-version: ${VERSION.replace(/\./g, "\\.")}`), `${name} 没锁版本`);
  }
});

test("壳里不许有业务逻辑：只负责找到入口", () => {
  const root = makeRepo();
  init(root);
  const body = fs.readFileSync(wrapperPath(root, "devcontrol"), "utf8");
  // 有实现就会包含这些内核里的概念；壳只该有「解析根目录 → 找入口 → exec」
  for (const word of ["task.claim", "E_NO_EVIDENCE", "fingerprint"]) {
    assert.equal(body.includes(word), false, `壳里出现了 ${word}：业务逻辑跑进壳里，改了内核壳就过期`);
  }
  assert.match(body, /DEVCONTROL_LOCAL_ENTRY/, "要留一个显式指定入口的开关，自测和本地 checkout 都靠它");
  assert.match(body, /npx --yes --cache/, "没有本地安装时得能退回锁定版本的 npx");
});

test("重复 init 不重写壳（幂等：不制造假改动）", () => {
  const root = makeRepo();
  init(root);
  const before = fs.readFileSync(wrapperPath(root, "devcontrol"), "utf8");
  const stat = fs.statSync(wrapperPath(root, "devcontrol"));
  init(root);
  const after = fs.readFileSync(wrapperPath(root, "devcontrol"), "utf8");
  assert.equal(after, before);
  assert.equal(fs.statSync(wrapperPath(root, "devcontrol")).mtimeMs, stat.mtimeMs, "内容没变还重写，git 上会多出一条假改动");
});

test("壳的版本落后了要重写：升级后不能还锁在旧版本上", () => {
  const root = makeRepo();
  init(root);
  const abs = wrapperPath(root, "devcontrol");
  // 模拟「项目里躺着上一版 init 写的壳」
  fs.writeFileSync(abs, `#!/usr/bin/env sh\n# devcontrol-cli-version: 0.0.1-alpha\nexit 0\n`, "utf8");
  const res = writeWrappers(root);
  // 只有被改坏的那一份要重写；另外两份内容本来就对，重写它们就是假改动
  assert.deepEqual(res.changed, ["devcontrol"], "只有版本落后的那份该被重写");
  assert.match(fs.readFileSync(abs, "utf8"), new RegExp(`devcontrol-cli-version: ${VERSION.replace(/\./g, "\\.")}`));
});

test("壳敲下去真的通：status 打到内核并返回 JSON", () => {
  const root = makeRepo();
  init(root);
  const abs = wrapperPath(root, "devcontrol");
  const opts = { cwd: root, encoding: "utf8", env: { ...process.env, DEVCONTROL_LOCAL_ENTRY: BIN } };
  const stdout =
    process.platform === "win32"
      ? execFileSync("cmd", ["/c", `${abs}.cmd`, "status"], opts)
      : execFileSync(abs, ["status"], opts);
  const out = JSON.parse(stdout);
  assert.equal(typeof out.phase, "string", `壳没打到内核：${stdout.slice(0, 200)}`);
  assert.ok(Array.isArray(out.actions), "status 该返回可用动作");
});

test("壳跟着 init 一起提交：装完 git status 必须是干净的", () => {
  const root = makeRepo();
  init(root);
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  assert.equal(
    status.trim(),
    "",
    `init 之后还有没提交的东西（第一次 close 会被 E_DIRTY_SCOPE 拦住）：\n${status}`,
  );
});