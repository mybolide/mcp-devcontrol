// devcontrol — 发布必须留下可回滚的点：annotated tag + 记录 sha
// 这些是用例是「发布语义」的守门人：没有 tag 就没有 `git checkout <tag>` 这种真回滚。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getTask } from "../src/store.js";
import { metaSet } from "../src/db.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import { createRelease, planRelease, shipRelease, getRelease } from "../src/release.js";
import { makeRepo, initFlow, newTask, sh } from "./helpers.js";

const finish = async (db, root, task) => {
  if (getTask(db, task.id).status === "backlog") taskClaim(db, root, { id: task.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), `export const a = "${task.id}";\n`);
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${task.id}`, { author: "agent" });
  return taskClose(db, root, { id: task.id });
};

test("发布留下可回滚点：ship 打 annotated tag，记 git_tag / git_sha", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t1 = newTask(db, root, reqId);
  const r = createRelease(db, { title: "v1.0" });
  planRelease(db, { id: r.id, tasks: [t1.id] });
  await finish(db, root, t1);

  const shipped = shipRelease(db, { id: r.id, root });
  assert.equal(shipped.status, "shipped");
  assert.ok(shipped.git_tag?.startsWith("release/v1.0-"), `tag 应指向这次发布：${shipped.git_tag}`);
  assert.match(shipped.git_sha ?? "", /^[0-9a-f]{40}$/);
  // 回滚点是真的：git 里查得到这个 tag，且它指的就是发布时的 HEAD
  assert.equal(sh(root, "git", "rev-parse", `${shipped.git_tag}^{commit}`).trim(), sh(root, "git", "rev-parse", "HEAD").trim());
  // annotated 而不是轻量 tag：轻量 tag 只是一个 ref，没有说明、也没法签名
  assert.equal(sh(root, "git", "cat-file", "-t", shipped.git_tag).trim(), "tag");
});

test("同名 tag 已存在就换号，不覆盖上一次的回滚点", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t1 = newTask(db, root, reqId);
  const r1 = createRelease(db, { title: "same" });
  planRelease(db, { id: r1.id, tasks: [t1.id] });
  await finish(db, root, t1);
  const a = shipRelease(db, { id: r1.id, root });
  const firstSha = sh(root, "git", "rev-parse", `${a.git_tag}^{commit}`).trim();

  const t2 = newTask(db, root, reqId);
  const r2 = createRelease(db, { title: "same" });
  planRelease(db, { id: r2.id, tasks: [t2.id] });
  await finish(db, root, t2);
  const b = shipRelease(db, { id: r2.id, root });

  assert.notEqual(a.git_tag, b.git_tag, "两次发布不能共用一个 tag");
  assert.equal(sh(root, "git", "rev-parse", `${a.git_tag}^{commit}`).trim(), firstSha, "旧 tag 不能被挪走");
});

test("还有任务在办时不许发布：否则半成品会被带上线", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t1 = newTask(db, root, reqId);
  const t2 = newTask(db, root, reqId);
  const r = createRelease(db, { title: "v2" });
  planRelease(db, { id: r.id, tasks: [t1.id] });
  await finish(db, root, t1);
  assert.equal(getRelease(db, r.id).pending, 0);

  // t2 没挂进发布，但正在做：它的半成品同样会跟着这次发布出去
  taskClaim(db, root, { id: t2.id }, "agent");
  assert.throws(
    () => shipRelease(db, { id: r.id, root }),
    (e) => e.code === "E_RELEASE_OPEN" && e.data.doing.length === 1,
  );
});

test("打不上 tag 就不算发布：E_RELEASE_TAG，状态仍留在 building", async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t1 = newTask(db, root, reqId);
  const r = createRelease(db, { title: "v3" });
  planRelease(db, { id: r.id, tasks: [t1.id] });
  await finish(db, root, t1);
  // 让 git 写不进 tag：.git/refs/tags 设成只读
  const tagsDir = path.join(root, ".git", "refs", "tags");
  fs.mkdirSync(tagsDir, { recursive: true });
  fs.chmodSync(tagsDir, 0o500);
  try {
    assert.throws(
      () => shipRelease(db, { id: r.id, root }),
      (e) => e.code === "E_RELEASE_TAG",
    );
  } finally {
    fs.chmodSync(tagsDir, 0o700);
  }
  assert.equal(getRelease(db, r.id).status, "building", "没打上 tag 就不能标记已发布");
});

test("弱模式发布：明确写出没有回滚点，不假装能回滚", () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  metaSet(db, "mode", "weak");
  const t1 = newTask(db, root, reqId);
  const r = createRelease(db, { title: "v4" });
  planRelease(db, { id: r.id, tasks: [t1.id] });
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(t1.id);
  const shipped = shipRelease(db, { id: r.id, root });
  assert.equal(shipped.status, "shipped");
  assert.equal(shipped.git_tag ?? null, null);
  assert.match(shipped.note ?? "", /弱模式/);
});