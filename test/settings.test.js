// devcontrol — 项目设置：默认值、写回合并、环境变量优先、记忆跟着项目走
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo } from "./helpers.js";
import { readSettings, writeSettings, effectiveSettings, settingsFile } from "../src/settings.js";
import { memoryConfig } from "../src/memory.js";

test("设置：默认值 → 写回合并 → 环境变量优先", () => {
  const root = makeRepo();

  const defaults = readSettings(root);
  assert.equal(defaults.console.port, 7373);
  assert.equal(defaults.memory.enabled, true);
  assert.equal(defaults.memory.provider, "ollama");

  writeSettings(root, { memory: { model: "bge-m3" }, console: { port: 7100 } });
  const saved = readSettings(root);
  assert.equal(saved.memory.model, "bge-m3");
  assert.equal(saved.console.port, 7100);
  assert.equal(saved.memory.qdrantUrl, "http://127.0.0.1:6333", "没动的字段保持默认");
  assert.equal(saved.console.restartGraceMs, 10000);
  assert.ok(fs.existsSync(path.join(root, ".devcontrol", "settings.json")));
  assert.equal(settingsFile(root), path.join(root, ".devcontrol", "settings.json"));

  // 环境变量优先级最高
  const eff = effectiveSettings(root, { DEVCONTROL_PORT: "7200", DEVCONTROL_MEMORY: "off" });
  assert.equal(eff.console.port, 7200);
  assert.equal(eff.memory.enabled, false);

  // 记忆跟着项目走：库文件在项目里，集合带项目 hash
  const cfg = memoryConfig({}, root);
  assert.equal(cfg.dbFile, path.join(root, ".devcontrol", "memory.db"));
  assert.equal(cfg.model, "bge-m3");
  assert.match(cfg.collection, /^devcontrol_memory_[0-9a-f]{8}$/);
});

test("设置文件坏掉也不影响使用（回落默认）", () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, ".devcontrol"), { recursive: true });
  fs.writeFileSync(path.join(root, ".devcontrol", "settings.json"), "{ 这不是 JSON");
  const s = readSettings(root);
  assert.equal(s.console.port, 7373);
});
