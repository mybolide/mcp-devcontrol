// devcontrol — 两个 Agent 真改到同一个文件时，要拦
//
// 上一轮修的是「scope 相交 ≠ 冲突」：共享 test/ 目录可以并行。
// 但那只解决到「目录」这一层——两个 Agent 都改 test/supplier.test.mjs 的时候，
// 后提交的会把先提交的盖掉，而且收口时谁也看不出来。
//
// 所以文件级再判一次：
//   · 撞同一个文件 → E_FILE_OVERLAP（提交时就拦）
//   · 同一个目录下的不同文件 → 放行（这才是并行的常态）
//   · 对方已经收口 → 不算撞车（顺序修改是正常的）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeRepo, initFlow, newTask, prove, BIN } from "./helpers.js";
import { fileClashes, taskClaim, taskClose } from "../src/gates.js";
import { commitFiles } from "../src/git.js";

const cli = (root, actor, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: actor },
  });

const touch = (root, rel, body = "export const x = 1;\n") => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

/** 两条在办任务，各管一片目录，共享 test/ */
function twoAgents(root) {
  const { db, reqId } = initFlow(root, { allowed: ["src", "test"] });
  const a = newTask(db, root, reqId, { title: "模型", scope: ["src/model", "test"] });
  const b = newTask(db, root, reqId, { title: "评级", scope: ["src/rating", "test"] });
  taskClaim(db, root, { id: a.id }, "agent-1");
  taskClaim(db, root, { id: b.id }, "agent-2");
  return { db, a, b };
}

test("两个人改不同文件：都不拦（并行的常态）", () => {
  const root = makeRepo();
  const { db, a, b } = twoAgents(root);

  touch(root, "test/model.test.mjs");
  touch(root, "test/rating.test.mjs");
  commitFiles(root, ["test/model.test.mjs"], `feat\n\nTask-Id: ${a.id}`, { author: "agent-1" });

  const r = cli(root, "agent-2", "commit", "-m", "feat: 评级测试");
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepEqual(fileClashes(db, root, b.id, ["test/rating.test.mjs"]), []);
});

test("两个人改同一个文件：第二个提交时拦住，并说清和谁撞了", () => {
  const root = makeRepo();
  const { db, a } = twoAgents(root);
  // agent-1 先提交
  touch(root, "test/supplier.test.mjs", "export const t1 = 1;\n");
  commitFiles(root, ["test/supplier.test.mjs"], `feat\n\nTask-Id: ${a.id}`, { author: "agent-1" });

  // agent-2 也改同一个文件再提交
  touch(root, "test/supplier.test.mjs", "export const t2 = 2;\n");
  const r = spawnSync(process.execPath, [BIN, "commit", "-m", "feat: 我也改了"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "agent-2" },
  });
  assert.notEqual(r.status, 0, "撞车必须拦住");
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.code, "E_FILE_OVERLAP");
  assert.match(payload.message, new RegExp(a.id), "要说清和哪条任务撞了");
  assert.match(payload.message, /supplier\.test\.mjs/);
  assert.ok(payload.hint, "要给出下一步");
});

test("对方已经收口，就不算撞车（顺序修改是正常的）", async () => {
  const root = makeRepo();
  const { db, a, b } = twoAgents(root);

  touch(root, "test/shared.test.mjs", "export const v = 1;\n");
  commitFiles(root, ["test/shared.test.mjs"], `feat\n\nTask-Id: ${a.id}`, { author: "agent-1" });
  prove(db, root, a.id);
  await taskClose(db, root, { id: a.id });

  // a 已经 done：它对 b 来说不是"在办任务"
  assert.deepEqual(fileClashes(db, root, b.id, ["test/shared.test.mjs"]), []);
});

test("收口时也再查一遍（双保险）", async () => {
  const root = makeRepo();
  const { db, a, b } = twoAgents(root);

  // 两人都提交了同一个文件（绕过 commit 的检查，模拟"检查上线前就在办的任务"）
  touch(root, "test/dup.test.mjs", "export const v1 = 1;\n");
  commitFiles(root, ["test/dup.test.mjs"], `feat\n\nTask-Id: ${a.id}`, { author: "agent-1" });
  touch(root, "test/dup.test.mjs", "export const v2 = 2;\n");
  commitFiles(root, ["test/dup.test.mjs"], `feat\n\nTask-Id: ${b.id}`, { author: "agent-2" });

  prove(db, root, a.id);
  await assert.rejects(
    () => taskClose(db, root, { id: a.id }),
    (e) => e.code === "E_FILE_OVERLAP" && /dup\.test\.mjs/.test(e.message),
  );
});

test("撞车不影响不相关的人：第三个人改自己的文件照旧能提交", () => {
  const root = makeRepo();
  const { a } = twoAgents(root);
  touch(root, "test/x.test.mjs", "export const v = 1;\n");
  commitFiles(root, ["test/x.test.mjs"], `feat\n\nTask-Id: ${a.id}`, { author: "agent-1" });

  // agent-2 改自己的文件：没和谁撞，不该被牵连
  touch(root, "test/y.test.mjs", "export const v = 2;\n");
  const r = cli(root, "agent-2", "commit", "-m", "feat: 我的文件");
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
