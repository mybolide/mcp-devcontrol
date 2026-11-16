// devcontrol — 库文件被换掉后，控制台必须重开，而不是继续对着已删除的旧文件写
//
// 为什么值得一条测试：这次全栈演练踩到的真实故障。
// .devcontrol/ 被清掉重建（重新 init / 从备份恢复 / 换项目快照）时，
// 控制台进程手里的 DatabaseSync 还指着那个已被删除的 inode。
// 于是 Owner 在页面上点「批准」，写进的是谁也看不见的旧文件：
// Agent 那边只看到「需求未批准」，Owner 那边看到「已批准」。
// 双方都没错，但两边永远对不上——这种 bug 没有报错，只能靠对 inode。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo } from "./helpers.js";
import { openDb, dbPath } from "../src/db.js";

const inodeOf = (root) => fs.statSync(dbPath(root)).ino;

test("删掉库再建：inode 变了，旧的句柄看不到新的批准", () => {
  const root = makeRepo();
  const first = openDb(root);
  const ino1 = inodeOf(root);
  first.close();

  fs.rmSync(path.join(root, ".devcontrol"), { recursive: true, force: true });
  const second = openDb(root);
  const ino2 = inodeOf(root);
  second.close();

  assert.notEqual(ino1, ino2, "重建库必须换 inode，否则这条检测不成立");
});

test("句柄未过期时 inode 不变（不能每次请求都重开）", () => {
  const root = makeRepo();
  const db = openDb(root);
  const a = inodeOf(root);
  db.prepare("INSERT INTO meta(key,value) VALUES('probe','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const b = inodeOf(root);
  db.close();
  assert.equal(a, b, "同一个库文件在写入后 inode 不该变");
});

test("控制台里带了 inode 检测：过期就重开，并用了 dbPath 取路径", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "console.js"), "utf8");
  assert.ok(src.includes("function freshDb("), "控制台需要 freshDb 来做句柄体检");
  assert.ok(src.includes("function inodeOf("), "需要 inodeOf 来判断库文件是否被换过");
  assert.ok(src.includes("dbPath"), "要用 dbPath 定位库文件，不能自己拼路径");
  assert.ok(src.includes("p.db = openDb(p.root)"), "过期后要真的重开，不能只是标记一下");
  // 每个读状态与 Owner 动作的入口都要过一遍体检
  assert.ok(src.includes("const adb = freshDb(active)"), "/api/state 要体检");
  assert.ok(src.includes("await action(freshDb(active)"), "/api/owner 要体检");
});

test("重开后能读到新库里的数据（模拟 Owner 批准落在新库上）", () => {
  const root = makeRepo();
  let db = openDb(root);
  db.prepare("INSERT INTO meta(key,value) VALUES('mark','old')").run();
  const ino1 = inodeOf(root);
  db.close();

  fs.rmSync(path.join(root, ".devcontrol"), { recursive: true, force: true });
  db = openDb(root);
  db.prepare("INSERT INTO meta(key,value) VALUES('mark','new')").run();
  const ino2 = inodeOf(root);
  assert.notEqual(ino1, ino2);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='mark'").get().value, "new");
  db.close();
});