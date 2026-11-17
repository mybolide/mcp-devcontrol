// doctor 得查「发布记录说的事，git 里还在不在」。
//
// 发布的意义就是留一个能 checkout 回去的点。如果 tag 被删了、改错了名字、
// 或者这台机器上根本没有（换机器/浅克隆），回滚点就已经没了，
// 而发布记录还写着 shipped —— 这种事只在出事那天才会被发现。
//
// 写这条检查时自己踩了一次：忘了 import git，每次调用都抛 ReferenceError，
// 被 catch 当成「tag 不存在」，于是所有发布全报错。所以下面专门有一条
// 「真的都在时不报」的用例——检查本身不能比它要防的问题更糟。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getTask } from "../src/store.js";
import { taskClaim, taskClose } from "../src/gates.js";
import { commitFiles } from "../src/git.js";
import { createRelease, planRelease, shipRelease } from "../src/release.js";
import { doctor } from "../src/report.js";
import { makeRepo, initFlow, newTask, sh, closeProven } from "./helpers.js";

const finish = async (db, root, task) => {
  if (getTask(db, task.id).status === "backlog") taskClaim(db, root, { id: task.id }, "agent");
  fs.writeFileSync(path.join(root, "src/a.js"), `export const a = "${task.id}";\n`);
  commitFiles(root, ["src/a.js"], `feat\n\nTask-Id: ${task.id}`, { author: "agent" });
  return closeProven(db, root, { id: task.id });
};

// 造一个"已发布"的仓库
const shippedRepo = async () => {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  const t = newTask(db, root, reqId);
  const r = createRelease(db, { title: "v1 首发" });
  planRelease(db, { id: r.id, tasks: [t.id] });
  await finish(db, root, t);
  const shipped = shipRelease(db, { id: r.id, root });
  return { root, db, task: t, reqId, release: shipped };
};

const tagIssues = (items) => items.filter((i) => i.code === "RELEASE_TAG_MISSING" || i.code === "RELEASE_NO_TAG");

test("tag 都在的时候不许误报（检查本身不能比它要防的问题更糟）", async () => {
  const { db, root } = await shippedRepo();
  assert.deepEqual(tagIssues(doctor(db, root)), [], `刚 ship 完就报回滚点没了，说明检查写错了：${JSON.stringify(tagIssues(doctor(db, root)))}`);
});

test("tag 被删掉：doctor 报 RELEASE_TAG_MISSING，并说清怎么补", async () => {
  const { root, db, release } = await shippedRepo();
  sh(root, "git", "tag", "-d", release.git_tag);

  const hits = tagIssues(doctor(db, root));
  assert.equal(hits.length, 1, `该正好报一条：${JSON.stringify(hits)}`);
  assert.equal(hits[0].severity, "error", "回滚点没了是 error，不是 note");
  assert.match(hits[0].detail, /release/, "得说清是哪个 tag");
  assert.match(hits[0].detail, /git tag -a/, "得给出把 tag 补回来的命令");
});

test("tag 名字被改错（记录还是旧的）：一样报出来", async () => {
  const { root, db, release } = await shippedRepo();
  // 模拟"改了命名规则之后记录没跟上"：记录里的名字和 git 里的对不上
  db.prepare("UPDATE releases SET git_tag=? WHERE id=?").run("release/写错了-2026-01-01", release.id);

  const hits = tagIssues(doctor(db, root));
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /写错了/, "把人写错的那个名字原样回显，不然它还得自己猜");
});

test("shipped 却没有 tag 字段：报 RELEASE_NO_TAG", async () => {
  const { root, db, release } = await shippedRepo();
  db.prepare("UPDATE releases SET git_tag=NULL WHERE id=?").run(release.id);

  const hits = tagIssues(doctor(db, root));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].code, "RELEASE_NO_TAG");
  assert.match(hits[0].detail, /回滚点不存在/);
});

test("没发布的版本不查（planned / building 本来就没有回滚点）", async () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  createRelease(db, { title: "还没发" });
  assert.deepEqual(tagIssues(doctor(db, root)), [], "planned 阶段报「回滚点没了」就是噪音");
});

test("一个仓库多个发布：只报真的缺的那个", async () => {
  const { root, db, reqId, release } = await shippedRepo();
  const t2 = newTask(db, root, reqId);
  const r2 = createRelease(db, { title: "v2 第二个" });
  planRelease(db, { id: r2.id, tasks: [t2.id] });
  await finish(db, root, t2);
  const s2 = shipRelease(db, { id: r2.id, root });

  sh(root, "git", "tag", "-d", s2.git_tag); // 只删第二个的
  const hits = tagIssues(doctor(db, root));
  assert.equal(hits.length, 1, `只该报被删的那一个：${JSON.stringify(hits)}`);
  assert.match(hits[0].detail, new RegExp(s2.id));
  assert.doesNotMatch(hits[0].detail, new RegExp(release.id), "另一个还在，别把账算错");
});