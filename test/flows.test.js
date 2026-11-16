// devcontrol — flow 模板：沉淀 / 读取 / 套用（门禁测试在 flow.test.js，别混）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FLOWS_REL, flowFromRequirement, flowToRequirement, listFlows, readFlow, writeFlow } from "../src/flow.js";
import { listReqs, listTasks } from "../src/store.js";
import { makeRepo, initFlow, newTask } from "./helpers.js";

test("写模板 → 读回来（字段与顺序都保持）", () => {
  const root = makeRepo();
  const saved = writeFlow(
    {
      name: "backend-feature",
      description: "后端功能：实现 + 补测试",
      acceptance: ["npm test :: exit==0", "npm run lint :: exit==0"],
      tasks: [
        { title: "实现接口", scope: ["src"], deriveFrom: [0] },
        { title: "补测试", scope: ["test"], deriveFrom: [0, 1], dependsOn: [0] },
      ],
    },
    root,
  );
  assert.ok(fs.existsSync(path.join(root, FLOWS_REL, "backend-feature.json")));

  const flow = readFlow("backend-feature", root);
  assert.deepEqual(flow.acceptance, ["npm test :: exit==0", "npm run lint :: exit==0"]);
  assert.equal(flow.tasks.length, 2);
  assert.deepEqual(flow.tasks[1].dependsOn, [0], "依赖用下标表示");
  assert.deepEqual(flow.tasks[1].deriveFrom, [0, 1]);
  assert.equal(saved.description, "后端功能：实现 + 补测试");
});

test("模板必须合法：名字、验收、越界下标、坏 JSON", () => {
  const root = makeRepo();
  assert.throws(() => writeFlow({ name: "Bad Name", acceptance: ["a"] }, root), (e) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => writeFlow({ name: "ok-name", acceptance: [] }, root), (e) => e.code === "INVALID_ARGUMENT");
  assert.throws(() => readFlow("nope", root), (e) => e.code === "NOT_FOUND");

  // 越界下标会被裁掉，不会写出坏模板
  const flow = writeFlow({ name: "clamp", acceptance: ["a"], tasks: [{ title: "t", deriveFrom: [0, 5], dependsOn: [0, 3] }] }, root);
  assert.deepEqual(flow.tasks[0].deriveFrom, [0]);
  assert.deepEqual(flow.tasks[0].dependsOn, [], "第一个任务不能依赖前面的任务或越界下标");

  fs.mkdirSync(path.join(root, FLOWS_REL), { recursive: true });
  fs.writeFileSync(path.join(root, FLOWS_REL, "broken.json"), "{ 不是 JSON");
  assert.throws(() => readFlow("broken", root), (e) => e.code === "INVALID_ARGUMENT");
  const listed = listFlows(root).find((f) => f.name === "broken");
  assert.ok(listed.error, "列表里要标出坏文件，而不是静默忽略");
});

test("从做过的需求沉淀：验收与任务拆法照抄，依赖转成下标", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const first = newTask(db, root, reqId, { title: "改实现", scope: ["src"] });
  newTask(db, root, reqId, { title: "补测试", scope: ["src/b.js"], dependsOn: [first.id] });

  const flow = flowFromRequirement(db, reqId, "our-way", root);
  assert.equal(flow.acceptance.length, 1);
  assert.equal(flow.tasks.length, 2);
  assert.deepEqual(flow.tasks[1].dependsOn, [0], "依赖应映射成第 1 个任务的下标");
  assert.deepEqual(flow.tasks[0].scope, ["src"]);
});

test("套用模板：只建需求草稿，等 Owner 批准（不越权建任务）", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  writeFlow({ name: "quick-fix", description: "小修复", acceptance: ["npm test :: exit==0"], tasks: [{ title: "改一下", scope: ["src"] }] }, root);

  const before = listReqs(db).length;
  const { requirementId, flow } = flowToRequirement(db, root, "quick-fix");
  const reqs = listReqs(db);
  assert.equal(reqs.length, before + 1);
  const created = reqs.find((r) => r.id === requirementId);
  assert.equal(created.status, "draft", "模板只能建草稿，批准是 Owner 的事");
  assert.deepEqual(created.acceptance, ["npm test :: exit==0"]);
  assert.equal(flow.tasks.length, 1);
  assert.equal(listTasks(db).length, 0, "套用模板不应该直接建任务");
});
