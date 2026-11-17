// devcontrol — 收口只核验证据，内核不跑测试
//
// 这是工具的分工线：测试是 Agent 的活（它有自己的 shell、自己的环境），
// 内核只回答「这段代码，真的跑过契约要求的那几条命令吗，而且过了吗」。
//
// 一旦内核自己去执行测试，它就得负责环境、依赖安装、超时、进程回收、干净检出——
// 工具会越来越重，还容易和项目真实的工作方式打架（v5 走岔的就是这条路）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, initFlow, newTask, prove } from "./helpers.js";
import { recordEvidence, taskClaim, taskClose } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import { getTask } from "../src/store.js";

/** 领任务 + 提交一笔交付（不含证据） */
function deliver(db, root, task, body = "export const a = 42;\n") {
  taskClaim(db, root, { id: task.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), body);
  commitFiles(root, ["src/a.js"], `feat: 改\n\nTask-Id: ${task.id}`, { author: "agent" });
}

test("没交证据就收口 → E_NO_EVIDENCE，并告诉他怎么交", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  deliver(db, root, t);

  await assert.rejects(
    () => taskClose(db, root, { id: t.id }),
    (e) => e.code === "E_NO_EVIDENCE" && /证据/.test(e.message),
  );
});

test("交了当前代码上的证据 → 收口通过，并把证据 id 带回来", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  deliver(db, root, t);
  const [ev] = prove(db, root, t.id);

  const res = await taskClose(db, root, { id: t.id });
  assert.equal(getTask(db, t.id).status, "done");
  assert.equal(res.runs.length, 1);
  assert.equal(res.runs[0].runId, ev.id, "收口要引用那条证据，不是自己新造一条");
  assert.equal(res.runs[0].passed, true);
});

test("跑完证据又改代码 → E_EVIDENCE_STALE（这就是指纹的用处）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  deliver(db, root, t);
  prove(db, root, t.id);

  // 交完证据又动了代码
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 43;\n");
  commitFiles(root, ["src/a.js"], `fix: 又改\n\nTask-Id: ${t.id}`, { author: "agent" });

  await assert.rejects(
    () => taskClose(db, root, { id: t.id }),
    (e) => e.code === "E_EVIDENCE_STALE" && /重跑/.test(e.message),
  );
});

test("证据里退出码不是 0 → E_ASSERTION_FAILED（不是让内核去跑一遍确认）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  deliver(db, root, t);
  prove(db, root, t.id, { exit: 1 });

  await assert.rejects(
    () => taskClose(db, root, { id: t.id }),
    (e) => e.code === "E_ASSERTION_FAILED" && /exit 1/.test(e.message),
  );
});

test("重跑一次（同代码新证据）就能覆盖掉旧的失败证据", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  deliver(db, root, t);
  prove(db, root, t.id, { exit: 1 });
  await assert.rejects(() => taskClose(db, root, { id: t.id }), (e) => e.code === "E_ASSERTION_FAILED");

  prove(db, root, t.id, { exit: 0 }); // 改好了，重跑
  // 上一次失败记了一轮返工，所以这次要交代一句
  const res = await taskClose(db, root, { id: t.id, resolvedBy: "断言写错了，补上再跑一次" });
  assert.equal(res.runs[0].passed, true);
});

test("别的任务的证据不算数", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const a = newTask(db, root, reqId, { title: "A" });
  deliver(db, root, a);
  prove(db, root, a.id);
  await taskClose(db, root, { id: a.id }); // 先把 A 收掉，WIP=1 才轮得到 B

  const b = newTask(db, root, reqId, { title: "B" });
  taskClaim(db, root, { id: b.id }, "agent");
  fs.writeFileSync(path.join(root, "src/b.js"), "export const b = 1;\n");
  commitFiles(root, ["src/b.js"], `feat: b\n\nTask-Id: ${b.id}`, { author: "agent" });

  // A 的证据不能拿来收 B
  await assert.rejects(() => taskClose(db, root, { id: b.id }), (e) => e.code === "E_NO_EVIDENCE");
});

test("证据类失败不计 review_round（少了这一步不该算「返工」）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  deliver(db, root, t);

  await assert.rejects(() => taskClose(db, root, { id: t.id }), (e) => e.code === "E_NO_EVIDENCE");
  assert.equal(getTask(db, t.id).review_round, 0, "忘跑测试不该被记成一次返工");

  prove(db, root, t.id);
  await taskClose(db, root, { id: t.id });
  assert.equal(getTask(db, t.id).status, "done");
});

test("recordEvidence 记的指纹是内容指纹：提交不改变它，改内容才改变", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 7;\n");

  const before = recordEvidence(db, root, { taskId: t.id, command: "npm test", result: { exit: 0, stdout: "", stderr: "" }, scope: t.scope });
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${t.id}`, { author: "agent" });
  const afterCommit = recordEvidence(db, root, { taskId: t.id, command: "npm test", result: { exit: 0, stdout: "", stderr: "" }, scope: t.scope });
  assert.equal(before.fingerprint, afterCommit.fingerprint, "提交不改内容，指纹应保持一致");

  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 8;\n");
  const afterEdit = recordEvidence(db, root, { taskId: t.id, command: "npm test", result: { exit: 0, stdout: "", stderr: "" }, scope: t.scope });
  assert.notEqual(afterEdit.fingerprint, afterCommit.fingerprint, "改了内容，指纹必须变");
});