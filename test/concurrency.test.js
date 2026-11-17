// devcontrol — 并发安全：scope 相交必须拦、同一任务只能被一个 Agent 抢到
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { intersect } from "../src/gates.js";
import { taskClaim } from "../src/gates.js";
import { makeRepo, initFlow, newTask, BIN } from "./helpers.js";

test("intersect：父目录与子路径算相交，前缀相近但不同的路径不算", () => {
  assert.equal(intersect(["src"], ["src/a.js"]), true, "粗粒度覆盖细粒度");
  assert.equal(intersect(["src/a.js"], ["src"]), true, "顺序无关");
  assert.equal(intersect(["src"], ["src"]), true, "完全相同");
  assert.equal(intersect(["src/a.js"], ["src/c.js"]), false, "不同文件不相交");
  assert.equal(intersect(["src/a"], ["src/ab"]), false, "前缀相近但不是父子目录");
  // "." 是根 scope（Path 允许整个仓库时，任务默认就是这个）。
  // 它能碰任何文件，所以必须和谁都算相交——早先按纯字符串前缀比，被判成不相交，
  // 于是两条 scope="." 的任务可以同时领，互相踩了也不知道。
  assert.equal(intersect(["."], ["src/a.js"]), true, "根 scope 覆盖一切");
});

test("scope 相交的任务不能被同时领取（E_SCOPE_OVERLAP）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const fine = newTask(db, root, reqId, { scope: ["src/a.js"], title: "细粒度" });
  const coarse = newTask(db, root, reqId, { scope: ["src"], title: "粗粒度" });
  const other = newTask(db, root, reqId, { scope: ["src/c.js"], title: "不重叠" });

  taskClaim(db, root, { id: fine.id }, "agentA");
  assert.throws(() => taskClaim(db, root, { id: coarse.id }, "agentB"), (e) => e.code === "E_SCOPE_OVERLAP");
  assert.doesNotThrow(() => taskClaim(db, root, { id: other.id }, "agentC"));
});

test("并发抢同一个任务：只有一个进程成功", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const task = newTask(db, root, reqId);

  const actors = ["race-1", "race-2", "race-3", "race-4"];
  const results = await Promise.all(
    actors.map(
      (actor) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [BIN, "task", "claim", task.id, "--actor", actor], { cwd: root });
          let err = "";
          child.stderr.on("data", (d) => (err += d));
          child.on("close", (code) => resolve({ actor, code, err }));
        }),
    ),
  );
  const winners = results.filter((r) => r.code === 0);
  assert.equal(winners.length, 1, `应只有 1 个成功，实际 ${winners.length}：${JSON.stringify(results)}`);
  for (const loser of results.filter((r) => r.code !== 0)) {
    assert.match(loser.err, /E_CLAIMED_BY_OTHER/, `落败的应该报 E_CLAIMED_BY_OTHER：${loser.err}`);
  }
});
