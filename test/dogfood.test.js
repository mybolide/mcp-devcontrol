// devcontrol — 真实项目演练暴露的三个坑（企业官网 dogfood 复盘）
// 1. close 失败时脚本读不到结果（JSON 走 stderr、成功没有 ok 字段）
// 2. 放行理由门槛太高、校验不在服务端兜住，放行失败却看不出来
// 3. ship 只看挂进发布的任务，忽略别人手上的在办任务
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRelease, getRelease, planRelease, shipRelease } from "../src/release.js";
import { getTask, listPaths, override, pathAdjust } from "../src/store.js";
import { hintFor } from "../src/hints.js";
import { readContract } from "../src/contract.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import { makeRepo, initFlow, newTask, closeProven } from "./helpers.js";

const BIN = path.resolve(import.meta.dirname, "../bin/devcontrol.js");

function dc(root, args) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_ACTOR: "dogfood" },
  });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("close 失败：stdout 也是可解析 JSON（带 ok:false 与 hint），脚本不用猜", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  const r = dc(root, ["close", t.id]);
  assert.equal(r.status, 1);
  const j = JSON.parse(r.out); // 关键：失败也用 stdout 出 JSON
  assert.equal(j.ok, false);
  assert.equal(j.code, "E_ILLEGAL_TRANSITION");
  assert.ok(j.hint, "要带一句下一步该做什么");
  assert.match(r.err, /E_ILLEGAL_TRANSITION/, "人读的一行仍在 stderr");
});

test("close 成功：JSON 里有 ok:true，和失败同一套字段", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  // 走到 doing 才能收口
  dc(root, ["task", "claim", t.id]);
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 99;\n");
  dc(root, ["commit", "-m", "feat: 改动"]);
  dc(root, ["run", "--", "npm test"]); // 工具不跑测试：证据要 Agent 自己留
  const r = dc(root, ["close", t.id]);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.ok(Array.isArray(j.runs));
});

test("放行理由太短被拒，且错误消息说清差多少字", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  assert.throws(
    () => override(db, { taskId: t.id, code: "E_DEP_OR_TEST_TOUCH", reason: "太短" }),
    (e) => e.code === "E_CONTRACT" && /现在 \d+ 字/.test(e.message),
  );
  // 12 字就能过：现实里没人愿意为一次放行写 30 字
  override(db, { taskId: t.id, code: "E_DEP_OR_TEST_TOUCH", reason: "本次页面功能与回归测试同批交付" });
});

test("waive 必须指明错误码（否则放行会被静默忽略）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  assert.throws(
    () => override(db, { taskId: t.id, mode: "waive", reason: "想说放行但忘了给 code" }),
    (e) => e.code === "E_CONTRACT" && /错误码/.test(e.message),
  );
});

test("ship：别人手上还有在办任务时不许发布（半成品会上线）", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const done = newTask(db, root, reqId);
  const other = newTask(db, root, reqId, { title: "别人的活儿", scope: ["src/b.js"] });
  const r = createRelease(db, { title: "v0.1" });
  planRelease(db, { id: r.id, tasks: [done.id] });
  // 把 done 手工标成完成（跳过重跑，只验发布门禁这一条）
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(done.id);
  db.prepare("UPDATE tasks SET status='doing', claimed_by='other-agent' WHERE id=?").run(other.id);

  assert.throws(() => shipRelease(db, { id: r.id }), (e) => e.code === "E_RELEASE_OPEN" && e.data.doing?.length === 1);
  assert.equal(getRelease(db, r.id).status, "building");

  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(other.id);
  assert.equal(shipRelease(db, { id: r.id }).status, "shipped");
});

test("新增测试不记，改既有测试记一笔（但都不拦）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  // ① 只新增一个测试文件：TDD 的正常动作，连记录都不该有
  const a = newTask(db, root, reqId, { title: "补新测试", scope: ["src"] });
  taskClaim(db, root, { id: a.id }, "agentA");
  fs.writeFileSync(path.join(root, "src/new.test.js"), 'import test from "node:test";\ntest("x", () => {});\n');
  commitFiles(root, ["src/new.test.js"], `feat\n\nTask-Id: ${a.id}\nDevControl-Base: ${a.base_head}`, { author: "agentA" });
  const resA = await closeProven(db, root, { id: a.id });
  assert.equal(resA.runs[0].passed, true);
  assert.deepEqual((resA.observations ?? []).filter((o) => o.id === "tests"), [], "新增测试不算「动了既有测试」");

  // ② 改既有测试：记一笔给 Owner 看，但仍然不拦——判不判是人的事
  const b = newTask(db, root, reqId, { title: "改老测试", scope: ["src"] });
  taskClaim(db, root, { id: b.id }, "agentA");
  fs.writeFileSync(path.join(root, "src/new.test.js"), 'import test from "node:test";\ntest("x", () => {});\n// 顺手放宽\n');
  commitFiles(root, ["src/new.test.js"], `chore\n\nTask-Id: ${b.id}\nDevControl-Base: ${b.base_head}`, { author: "agentA" });
  const resB = await closeProven(db, root, { id: b.id, resolvedBy: "按规范对照确认过" });
  const obs = (resB.observations ?? []).filter((o) => o.id === "tests");
  assert.equal(obs.length, 1, "动了既有测试要如实记下来");
  assert.match(obs[0].detail, /new\.test\.js/);
});
