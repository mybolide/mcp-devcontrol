// devcontrol — 归属不能被静默击穿
//
// 事故：A 领任务、改了文件、没提交就交接；B 接手、提交时把 A 的改动一起收进
// 自己的 Task-Id。事后 git 里分不出谁写的，「证据」和「归属」一起失效。
// 修法：接活那一刻给工作区拍快照，之后提交时分清「我写的」和「我继承的」。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { taskClaim } from "../src/gates.js";
import { makeRepo, initFlow, newTask, BIN } from "./helpers.js";

const cli = (root, actor, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: actor },
  });

const write = (root, rel, body = "x\n") => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

test("接活时工作树是干净的：自己写的照常提交，不误伤", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/mine.js"] });
  taskClaim(db, root, { id: t.id }, "a1");

  write(root, "src/mine.js"); // 接活之后才写的
  const r = cli(root, "a1", "commit", "-m", "feat: mine");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 个文件/);
});

test("接活前就有的改动：拦住，并说清是谁的问题", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/inherited.js"] });

  write(root, "src/inherited.js"); // 先脏，再接活——模拟上一任留下的
  taskClaim(db, root, { id: t.id }, "a2");

  const r = cli(root, "a2", "commit", "-m", "feat: 想占为己有");
  assert.equal(r.status, 1, r.stdout);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "E_INHERITED_CHANGE");
  assert.deepEqual(payload.data.files, ["src/inherited.js"]);
  assert.match(payload.hint, /take-over/, "hint 必须给出下一步");
});

test("确认要一起提交就加 --take-over：放行，并且把接管的事说出来", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src/inherited.js"] });
  write(root, "src/inherited.js");
  taskClaim(db, root, { id: t.id }, "a3");

  const r = cli(root, "a3", "commit", "-m", "feat: 接手", "--take-over");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /接管 1 个接活前就存在的改动/);
});

test("接活前脏的是别人的地盘：还是报 E_SCOPE_VIOLATION，不抢答", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId, { scope: ["src"] });
  write(root, "outside.txt", "x\n"); // scope 外
  taskClaim(db, root, { id: t.id }, "a4");

  const r = cli(root, "a4", "commit", "-m", "feat: 越界");
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).code, "E_SCOPE_VIOLATION");
});

test("两个 Agent 先后接同一片：第二个不许把第一个的活记成自己的", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const taskA = newTask(db, root, reqId, { scope: ["src/a.js"], title: "A 的活" });
  taskClaim(db, root, { id: taskA.id }, "agent-a");
  write(root, "src/a.js", "// A 写的\n");

  // A 没提交就释放（交接的常见形态）
  const { taskRelease } = await import("../src/store.js");
  taskRelease(db, { taskId: taskA.id });

  const taskB = newTask(db, root, reqId, { scope: ["src"], title: "B 的活" });
  taskClaim(db, root, { id: taskB.id }, "agent-b");
  write(root, "src/b.js", "// B 写的\n");

  const r = cli(root, "agent-b", "commit", "-m", "feat: B 的提交");
  assert.equal(r.status, 1, "把 A 的未提交改动收进 B 的 Task-Id 必须被拦住");
  assert.equal(JSON.parse(r.stdout).code, "E_INHERITED_CHANGE");
  assert.match(JSON.parse(r.stdout).data.files.join(","), /src\/a\.js/);
});
