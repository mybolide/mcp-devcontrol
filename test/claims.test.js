// devcontrol — 「声称做到了」和「真的做到了」是两件事
//
// 这个工具里有大量承诺是以文字形式存在的：SKILL 说「next.args 照抄就能执行」、
// README 说「export 是只读快照」、控制台上每个按钮都暗示「点了有用」。
// 之前的教训是：这些话很容易只对了一半（handoff 说交接、实际只发卡片）。
//
// 所以这里不读文档，只做：
//   把每句承诺**真的执行一遍**，看它是否兑现。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { makeRepo, initFlow, newTask, prove } from "./helpers.js";
import { bootstrap } from "../src/digest.js";
import { taskClaim, taskClose, taskCreate } from "../src/gates.js";
import { getTask, listTasks } from "../src/store.js";
import { commitFiles } from "../src/git.js";
import { exportMarkdown } from "../src/report.js";
import { openDb } from "../src/db.js";

/** 把 next.args 喂给对应动作，返回是否被"参数问题"挡下 */
async function followNext(db, root, next) {
  const args = next.args ?? {};
  switch (next.action) {
    case "task.create":
      return taskCreate(db, root, args);
    case "task.claim":
      return taskClaim(db, root, args, "agent");
    case "task.close":
      return taskClose(db, root, args);
    case "wait":
      return { waited: true };
    default:
      throw new Error(`没覆盖的动作：${next.action}`);
  }
}

test("承诺①：next.args 照抄就能执行（不是每次都要人补参数）", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);

  // 场景 A：需求验收没人管 → next 让建任务
  const n1 = bootstrap(db, root).next;
  assert.equal(n1.action, "task.create");
  const created = await followNext(db, root, n1);
  assert.ok(created.id, "照抄 next.args 应该真的建出任务");

  // 场景 B：有任务可领 → next 让领
  const n2 = bootstrap(db, root).next;
  assert.equal(n2.action, "task.claim");
  await followNext(db, root, n2);

  // 场景 C：在办 → next 让收口
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 3;\n");
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${created.id}`, { author: "agent" });
  prove(db, root, created.id);
  const n3 = bootstrap(db, root).next;
  assert.equal(n3.action, "task.close");
  const closed = await followNext(db, root, n3);
  assert.equal(getTask(db, created.id).status, "done", `照抄 next.args 应该能收口：${JSON.stringify(closed)}`);
  void reqId;
});

test("承诺②：export 是只读快照——跑完之后库文件一个字节都不变", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  newTask(db, root, reqId);
  db.close(); // 先关掉，让文件落盘

  const file = path.join(root, ".devcontrol/state.db");
  const hash = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const before = hash();

  const db2 = openDb(root);
  const md = exportMarkdown(db2);
  db2.close();

  assert.ok(md.includes("devcontrol 快照"), "导出内容得像回事");
  assert.equal(hash(), before, "export 说只读，就不能改库文件");
});

test("承诺③：发布说留了回滚点，就真的能 checkout 回来", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  taskClaim(db, root, { id: t.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 9;\n");
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${t.id}`, { author: "agent" });
  prove(db, root, t.id);
  await taskClose(db, root, { id: t.id });

  const { createRelease, planRelease, shipRelease } = await import("../src/release.js");
  const rel = createRelease(db, { title: "v1.0" });
  planRelease(db, { id: rel.id, tasks: [t.id] });
  const shipped = shipRelease(db, { id: rel.id, root });

  assert.match(shipped.git_tag, /^release\//, "要打一个能认出来的 tag");
  // 真的能在那个点检出：这是"回滚点"唯一的检验方式
  const { spawnSync } = await import("node:child_process");
  const show = spawnSync("git", ["rev-parse", `${shipped.git_tag}^{commit}`], { cwd: root, encoding: "utf8" });
  assert.equal(show.status, 0, `tag 不存在：${shipped.git_tag}`);
  assert.match(show.stdout.trim(), new RegExp(`^${shipped.git_sha}`), "tag 指向的必须正是记录下来的那个提交");
});

test("承诺④：flow 存下来的模板真能 apply 出一个需求", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  newTask(db, root, reqId);

  const { flowFromRequirement, listFlows, flowToRequirement } = await import("../src/flow.js");
  flowFromRequirement(db, reqId, "edit-one-file", root);
  assert.ok(listFlows(root).some((f) => f.name === "edit-one-file"), "模板要真的落盘");

  const applied = flowToRequirement(db, root, "edit-one-file");
  assert.ok(applied.requirementId, "apply 要真的建出需求");
  assert.ok(applied.flow.tasks.length >= 1, "模板里的任务拆分要带得回来");
});

test("承诺⑤：控制台每个按钮都有前端 handler（点了没反应就是骗人）", () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, "..", "public", "index.html"), "utf8");
  // 找出所有 data-* 动作属性
  const attrs = new Set([...html.matchAll(/data-([a-z][a-z-]*)="\$\{/g)].map((m) => m[1]));
  const handlers = html.slice(html.indexOf('document.addEventListener("click"'));
  const orphans = [...attrs].filter((a) => {
    const camel = a.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return !handlers.includes(`dataset.${camel}`);
  });
  assert.deepEqual(orphans, [], `这些按钮没有 handler，点了不会动：${orphans.join(", ")}`);
});
