// devcontrol — 纪律三数：被拦 / 返工 / 绕过
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { disciplineStats, getTask, override } from "../src/store.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { bootstrap } from "../src/digest.js";
import { commitFiles } from "../src/git.js";
import { makeRepo, initFlow, newTask, closeProven } from "./helpers.js";

const REASON = "Owner 决定：这条断言在本机环境不稳定，本次先放行，后续补测。";

test("三数：被拦、返工、绕过都能算出来", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);
  taskClaim(db, root, { id: task.id }, "agentA");

  assert.deepEqual(disciplineStats(db), { blocked: 0, envOnly: 0, rework: 0, bypassed: 0, done: 0 });

  // 提交里夹带 scope 外的文件 → 收口被拦一次，同时记一轮返工
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 2;\n");
  fs.writeFileSync(path.join(root, "outside.js"), "export const o = 1;\n");
  commitFiles(root, ["src/a.js", "outside.js"], `feat\n\nTask-Id: ${task.id}`, { author: "agentA" });
  await assert.rejects(
    () => closeProven(db, root, { id: task.id }),
    (e) => ["E_SCOPE_VIOLATION", "E_UNREGISTERED_FILES"].includes(e.code),
  );
  assert.equal(disciplineStats(db).blocked, 1, "close.fail 计一次被拦");
  assert.equal(disciplineStats(db).rework, 1, "review_round 计一轮返工");

  // Owner 放行一次 = 绕过一次（这时会要求 resolvedBy，先带上）
  const res = await closeProven(db, root, {
    id: task.id,
    resolvedBy: "把 scope 外的文件撤掉，只留 src 内的改动",
  }).catch((e) => e);
  assert.ok(res.code, `仍应被拦：${JSON.stringify(res)}`);
  assert.equal(disciplineStats(db).blocked, 2);

  override(db, { taskId: task.id, code: "E_DIFF_BUDGET", reason: REASON });
  assert.equal(disciplineStats(db).bypassed, 1);

  // bootstrap 里也带着这三个数
  const digest = bootstrap(db, root);
  assert.equal(digest.stats.blocked, 2);
  assert.equal(digest.stats.bypassed, 1);
  assert.equal(getTask(db, task.id).status, "doing");
});
