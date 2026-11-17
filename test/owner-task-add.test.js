// devcontrol — Owner 能直接下单
//
// 单人场景里，人心里已经知道要做什么，却得先提需求、批准 Path、再等 Agent 拆出
// 「覆盖验收：npm test :: exit==0」这种机器标题——这个绕路没有意义。
// 现在 Owner 在控制台直接建任务：自己写标题、自己定 scope 和验收。
//
// 但「人是 Owner」不等于「人不用守契约」：校验走的还是同一个 taskCreate，
// 需求没批准、验收命令不在白名单，Owner 一样过不去。
import test from "node:test";
import assert from "node:assert/strict";
import { makeRepo, initFlow } from "./helpers.js";
import { openDb } from "../src/db.js";
import { OWNER_ACTIONS } from "../src/console.js";
import { listTasks, listReqs, listPaths } from "../src/store.js";

const add = (db, root, payload) => OWNER_ACTIONS["task.add"](db, root, payload);

test("Owner 建任务：标题自己写，进 backlog 等 Agent 领", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = add(db, root, {
    requirementId: reqId,
    pathId: "P-001",
    kind: "feature",
    title: "把导出按钮挪到右上角",
    scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  assert.equal(t.title, "把导出按钮挪到右上角", "标题是人写的，不是内核按验收生成的");
  assert.ok(listTasks(db).some((x) => x.id === t.id && x.status === "backlog"));
});

test("Owner 建任务也受契约约束：需求没批准就建不了", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  db.prepare("UPDATE requirements SET status='draft' WHERE id=?").run(reqId);
  assert.throws(
    () => add(db, root, { requirementId: reqId, pathId: "P-001", title: "偷建的", acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }] }),
    (e) => e.code === "E_NEED_APPROVED",
  );
});

test("Owner 建任务也受契约约束：验收命令不在白名单就建不了", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  assert.throws(
    () =>
      add(db, root, {
        requirementId: reqId,
        pathId: "P-001",
        title: "用了契约外的命令",
        acceptance: [{ deriveFrom: 0, assertion: "make deploy :: exit==0" }],
      }),
    (e) => e.code === "E_CONTRACT",
  );
});

test("Owner 建任务也要守 scope：超出 Path 允许的区域会被拒", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  // initFlow 的 P-001 只允许 src
  assert.throws(
    () =>
      add(db, root, {
        requirementId: reqId,
        pathId: "P-001",
        title: "越界",
        scope: ["docs"],
        acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
      }),
    (e) => e.code === "E_CONTRACT",
  );
});

test("Owner 建的任务能被 Agent 正常领取（不是只读的摆设）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const { taskClaim } = await import("../src/gates.js");
  const t = add(db, root, {
    requirementId: reqId,
    pathId: "P-001",
    title: "Agent 去干这个",
    scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  const claimed = taskClaim(db, root, { id: t.id }, "agent");
  assert.equal(claimed.id, t.id);
  assert.ok(claimed.standards?.rules?.length, "领到任务同时拿到规范");
});

test("控制台里登记了这个动作（否则按钮点了没反应）", () => {
  assert.equal(typeof OWNER_ACTIONS["task.add"], "function");
});

test("建出来的任务不影响已有需求/Path 的统计", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const before = { reqs: listReqs(db).length, paths: listPaths(db).length };
  add(db, root, {
    requirementId: reqId,
    pathId: "P-001",
    title: "只加任务",
    scope: ["src"],
    acceptance: [{ deriveFrom: 0, assertion: "npm test :: exit==0" }],
  });
  assert.deepEqual({ reqs: listReqs(db).length, paths: listPaths(db).length }, before);
});