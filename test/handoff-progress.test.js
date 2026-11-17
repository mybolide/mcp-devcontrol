// devcontrol — 交接卡片要说实话：这张活干到哪了
// 事故：在办任务的卡片写「已用 0 行」，而它已经提交了；changed_lines 只在收口时才写。
// 接手的人拿到一条假进度，比什么都不给更坏。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { taskClaim } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import { handoff } from "../src/store.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";

const land = (root, rel, id, author = "agent-x", content = "x") => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${content}\n`);
  return commitFiles(root, [rel], `feat: ${id}\n\nTask-Id: ${id}`, { author });
};

test("有提交时，卡片写真实进度而不是「已用 0 行」", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/new.js"], title: "做一半" });
  taskClaim(db, root, { id: t.id }, "agent-x");
  land(root, "src/new.js", t.id);

  const card = handoff(db, { taskId: t.id }, root).text;
  assert.match(card, /进度: 已提交 1 个（1 行 \/ 1 处文件）/, card);
  assert.doesNotMatch(card, /已用 0/, "假进度又冒出来了");
});

test("两个提交累加，文件数去重", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/n1.js", "src/n2.js"], title: "两段" });
  taskClaim(db, root, { id: t.id }, "agent-x");
  land(root, "src/n1.js", t.id);
  land(root, "src/n2.js", t.id);

  const card = handoff(db, { taskId: t.id }, root).text;
  assert.match(card, /已提交 2 个（2 行 \/ 2 处文件）/, card);
});

test("别的任务的提交不算进来", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const mine = newTask(db, root, reqId, { scope: ["src/a.js"], title: "我的" });
  const other = newTask(db, root, reqId, { scope: ["src/b.js"], title: "别人的" });
  taskClaim(db, root, { id: mine.id }, "agent-x");
  land(root, "src/b.js", other.id); // 别人的提交
  land(root, "src/a.js", mine.id);

  const card = handoff(db, { taskId: mine.id }, root).text;
  assert.match(card, /已提交 1 个/, "把别人的提交算我头上了");
});

test("一行都没提：直说「还没有提交，从头做」", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/a.js"], title: "还没动" });
  taskClaim(db, root, { id: t.id }, "agent-x");

  const card = handoff(db, { taskId: t.id }, root).text;
  assert.match(card, /进度: 还没有提交，从头做/);
});

test("被拦过就把拦截码写进卡片：接手的人知道上一关卡在哪", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/a.js"], title: "卡住过" });
  db.prepare("INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)").run(
    new Date().toISOString(), "agent-x", "agent", "close.fail", t.id, "E_NO_EVIDENCE", "第 1 次",
  );

  const card = handoff(db, { taskId: t.id }, root).text;
  assert.match(card, /上次被拦 E_NO_EVIDENCE（第 1 次）/);
});

test("不给 root 也不炸：进度说不准就只说没提交", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/a.js"] });
  taskClaim(db, root, { id: t.id }, "agent-x");
  land(root, "src/a.js", t.id);

  const card = handoff(db, { taskId: t.id }).text;
  assert.match(card, /进度: 还没有提交/);
});

test("交接仍然顺手释放：卡片和可领状态是一起的", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/a.js"] });
  taskClaim(db, root, { id: t.id }, "agent-x");

  const r = handoff(db, { taskId: t.id }, root);
  assert.equal(r.released.status, "backlog");
  assert.match(r.text, /已释放/);
  assert.equal(db.prepare("SELECT claimed_by FROM tasks WHERE id=?").get(t.id).claimed_by, null);
});