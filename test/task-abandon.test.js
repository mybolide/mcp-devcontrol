// devcontrol — Owner 得能作废一条任务
//
// dogfood 里真撞到的：建了一条临时任务去验证一件事，验完没用了。
// 它卡着 WIP=1（之后什么都领不了），也挡着发布（release ship 报「还有没完成的」），
// 而 CLI 上一条出口都没有——控制台能作废「需求」，作废不了「一条任务」。
//
// 为什么不做成 Agent 的动作：Agent 能作废任务，就等于能甩掉不好做的活。
// 这是 Owner 的决定，所以只给 CLI（记 channel=cli）和控制台，不进 MCP。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeRepo, initFlow, BIN } from "./helpers.js";
import { taskAbandon } from "../src/store.js";
import { taskClaim, taskCreate } from "../src/gates.js";

const addTask = (db, root, reqId, title = "临时任务", scope = ["src"]) =>
  taskCreate(db, root, {
    requirementId: reqId,
    pathId: "P-001",
    kind: "feature",
    title,
    scope,
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });

test("taskAbandon：backlog 的任务作废后就是 abandoned", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = addTask(db, root, reqId);
  const res = taskAbandon(db, root, { taskId: t.id, reason: "只是拿来验一下，不需要了" });
  assert.equal(res.status, "abandoned");
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(t.id).status, "abandoned");
});

test("taskAbandon：作废在办任务，就把 WIP 让出来了（否则永远领不了下一条）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const first = addTask(db, root, reqId, "先领这条", ["src"]);
  const second = addTask(db, root, reqId, "再领这条", ["src"]);
  taskClaim(db, root, { id: first.id }, "agent");
  assert.throws(() => taskClaim(db, root, { id: second.id }, "agent"), (e) => e.code === "E_WIP_LIMIT", "前提：WIP=1 挡住了第二条");

  taskAbandon(db, root, { taskId: first.id, reason: "建错了，这条不做" });
  const got = taskClaim(db, root, { id: second.id }, "agent");
  assert.equal(got.id, second.id, "作废之后应该能领下一条");

  // 作废的任务不能还挂着领用人：它已经不在任何人手上，界面上显示「agent 在办」就是撒谎
  const row = db.prepare("SELECT status, claimed_by, claim_expires_at FROM tasks WHERE id=?").get(first.id);
  assert.equal(row.status, "abandoned");
  assert.equal(row.claimed_by, null, "作废了还留着领用人，看板上会显示成还在做");
  assert.equal(row.claim_expires_at, null, "租约也要清掉，否则看起来还在别人手上");
});


test("taskAbandon：已经收口的任务不能作废", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = addTask(db, root, reqId);
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(t.id);
  assert.throws(
    () => taskAbandon(db, root, { taskId: t.id, reason: "想反悔一下看看行不行" }),
    (e) => e.code === "E_ILLEGAL_TRANSITION",
  );
});

test("taskAbandon：必须写理由（以后才知道为什么没做）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = addTask(db, root, reqId);
  assert.throws(
    () => taskAbandon(db, root, { taskId: t.id, reason: "不做" }),
    (e) => e.code === "E_CONTRACT" && /至少 8 字/.test(e.message),
  );
});

test("CLI：不给编号时，列出还没做完的任务，并给一条照抄就能跑的命令", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = addTask(db, root, reqId, "脏任务", ["src"]);

  const out = spawnSync(process.execPath, [BIN, "task", "abandon"], { cwd: root, encoding: "utf8" });
  assert.equal(out.status, 2);
  assert.match(out.stderr, new RegExp(t.id), "要把能作废的任务摆出来");
  const line = out.stderr.split("\n").find((l) => l.includes("照抄这条："));
  assert.ok(line, `没给可抄的命令：${out.stderr}`);

  const cmd = line.split("照抄这条：")[1].trim();
  const [bin, ...args] = cmd.split(/\s+/);
  assert.equal(bin, "devcontrol");
  const ran = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(ran.status, 0, `提示里的命令跑不通：${cmd}\n${ran.stderr}`);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").get(t.id).status, "abandoned", "照抄的命令要真的能作废");
});