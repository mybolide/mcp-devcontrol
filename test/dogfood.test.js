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
import { override } from "../src/store.js";
import { hintFor } from "../src/hints.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";

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

test("hint 覆盖所有会被 Agent 撞到的门禁码（漏了就返回 null，不会瞎编）", () => {
  const codes = [
    "E_NEED_APPROVED",
    "E_NO_DELIVERY",
    "E_UNOWNED_COMMIT",
    "E_SCOPE_VIOLATION",
    "E_DEP_OR_TEST_TOUCH",
    "E_DIFF_BUDGET",
    "E_ASSERTION_FAILED",
    "E_WIP_LIMIT",
    "E_SCOPE_OVERLAP",
    "E_NEED_RESOLUTION",
    "E_RELEASE_OPEN",
  ];
  for (const code of codes) assert.ok(hintFor({ code }), `${code} 缺一句提示`);
  assert.equal(hintFor({ code: "E_NOT_A_REAL_CODE" }), null);
  assert.equal(hintFor({}), null);
});
