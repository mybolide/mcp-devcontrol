// devcontrol — 记忆体检的口径：按项目算 + 分清「环境没开」和「真的坏了」
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { doctor } from "../src/report.js";
import { memoryConfig, openMemory, remember, memoryStatus } from "../src/memory.js";
import { skillContent } from "../src/skill.js";
import { makeRepo, BIN } from "./helpers.js";

const projectOf = (root) => path.basename(root);

/** 往本项目的记忆库里塞几条，并按需改掉索引状态（模拟建索引失败） */
function seed(root, rows) {
  const cfg = memoryConfig({}, root);
  const db = openMemory(cfg);
  for (const r of rows) {
    remember(db, { kind: "pitfall", status: "active", ...r });
  }
  for (const r of rows) {
    if (!r.indexState) continue;
    db.prepare("UPDATE memories SET index_state=?, index_error=? WHERE title=?").run(r.indexState, r.indexError ?? null, r.title);
  }
  db.close();
  return cfg;
}

test("记忆体检只统计本项目的条目：别的项目留下的失败不算在本项目头上", () => {
  const root = makeRepo();
  const mine = projectOf(root);
  const cfg = seed(root, [
    { title: "本项目的坑", body: "本项目的坑的详情，写够长一点。", project: mine },
    { title: "通用条目", body: "没记出处的通用条目详情。", project: null },
    { title: "别的项目的坑", body: "别的项目留下的坑详情。", project: "some-other-project", indexState: "failed", indexError: "500 Internal Server Error" },
  ]);

  const scoped = memoryStatus(cfg, { project: mine });
  assert.equal(scoped.total, 2, "两个项目的条目不该混在一起算");
  assert.equal(scoped.project, mine, "结果要带上算的是哪个项目");
  assert.equal(scoped.byState.failed ?? 0, 0, "别的项目的失败不该冒到本项目头上");

  const all = memoryStatus(cfg);
  assert.equal(all.total, 3, "不指定项目时是全量（devcontrol memory status 用）");
});

test("向量服务连不上＝环境状况（offline）；有一条真错误就算真失败", () => {
  const root = makeRepo();
  const mine = projectOf(root);

  const offlineOnly = seed(root, [
    { title: "坑一", body: "坑一的详情，写够长一点。", project: mine, indexState: "failed", indexError: "fetch failed" },
    { title: "坑二", body: "坑二的详情，写够长一点。", project: mine, indexState: "failed", indexError: "connect ECONNREFUSED 127.0.0.1:11434" },
  ]);
  const a = memoryStatus(offlineOnly, { project: mine });
  assert.equal(a.byState.failed, 2);
  assert.equal(a.offline, true, "全是网络类错误 → 只是向量服务没开");
  assert.ok(a.indexErrors.length >= 1, "要能看到原始错误，便于判断");

  const mixed = seed(root, [
    { title: "坑三", body: "坑三的详情，写够长一点。", project: mine, indexState: "failed", indexError: "维度不匹配：期望 768 实际 1536" },
  ]);
  const b = memoryStatus(mixed, { project: mine });
  assert.equal(b.offline, false, "非网络类错误＝真坏了，不能糊成环境问题");
});

test("doctor：向量服务连不上只报 note（info），不是 warn", () => {
  const root = makeRepo();
  const mine = projectOf(root);
  openDb(root).close();
  seed(root, [{ title: "坑一", body: "坑一的详情，写够长一点。", project: mine, indexState: "failed", indexError: "fetch failed" }]);

  const db = openDb(root);
  const items = doctor(db, root);
  db.close();

  const offline = items.find((i) => i.code === "MEMORY_INDEX_OFFLINE");
  assert.ok(offline, "应该报 MEMORY_INDEX_OFFLINE");
  assert.equal(offline.severity, "info", "环境问题不该是 warn：人不用去修没坏的东西");
  assert.match(offline.detail, /关键词/, "要说明会退回关键词检索，不是不能用");
  assert.equal(items.some((i) => i.code === "MEMORY_INDEX_FAILED"), false, "别把同一件事同时说成真失败");

  // CLI 上的标签也要一致：note，而不是 warn
  const out = execFileSync(process.execPath, [BIN, "doctor"], { cwd: root, encoding: "utf8" });
  assert.match(out, /note\s+MEMORY_INDEX_OFFLINE/, "doctor 输出应标成 note");
});

test("doctor：真的索引失败才是 warn，且只算本项目的", () => {
  const root = makeRepo();
  const mine = projectOf(root);
  openDb(root).close();
  seed(root, [
    { title: "坑一", body: "坑一的详情，写够长一点。", project: mine, indexState: "failed", indexError: "维度不匹配：期望 768 实际 1536" },
    { title: "别人的坑", body: "别的项目的坑详情，写够长一点。", project: "other-project", indexState: "failed", indexError: "维度不匹配：期望 768 实际 1536" },
  ]);

  const db = openDb(root);
  const items = doctor(db, root);
  db.close();

  const failed = items.find((i) => i.code === "MEMORY_INDEX_FAILED");
  assert.ok(failed, "非网络类失败要报 MEMORY_INDEX_FAILED");
  assert.equal(failed.severity, "warn");
  assert.match(failed.detail, /^1 条/, "只数本项目那一条（别的项目的失败不算）");
  assert.equal(items.some((i) => i.code === "MEMORY_INDEX_OFFLINE"), false);
});

test("Agent 说明里写清了：Owner 审批必须真人确认，不能由 Agent 代签", () => {
  const body = skillContent();
  assert.match(body, /Owner 的审批需要真人确认，Agent 不能代签/, "要有一节专门讲这件事");
  assert.match(body, /devcontrol serve/, "要说清 Owner 用什么界面");
  assert.match(body, /不要改用 Agent shell 冒充 Owner/, "要明确禁止绕过");
  // 人类动作清单里几条最容易踩的要出现
  for (const kw of [/批准/, /放行/, /预算/, /重采/]) assert.match(body, kw);
});
