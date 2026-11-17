// devcontrol — 发布插件：一次交付 = 一组任务，全部 done 才能 ship
import { logEvent, metaGet, nextId } from "./db.js";
import { git, head } from "./git.js";
import { fail, now, taskExists } from "./store.js";

const RELEASE_STATUS = ["planned", "building", "shipped"];

export function getRelease(db, id) {
  const row = db.prepare("SELECT * FROM releases WHERE id=?").get(id);
  if (!row) return null;
  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.status FROM release_tasks rt JOIN tasks t ON t.id = rt.task_id
        WHERE rt.release_id=? ORDER BY t.id`,
    )
    .all(id);
  return { ...row, tasks, pending: tasks.filter((t) => t.status !== "done").length };
}

export function listReleases(db) {
  return db
    .prepare("SELECT id FROM releases ORDER BY created_at DESC")
    .all()
    .map((r) => getRelease(db, r.id))
    .filter(Boolean);
}

export function createRelease(db, { title, targetDate } = {}) {
  const name = String(title ?? "").trim();
  if (!name) fail("E_CONTRACT", "发布需要一个名字");
  const id = nextId(db, "R");
  db.prepare("INSERT INTO releases(id,title,status,target_date,created_at) VALUES(?,?,?,?,?)").run(id, name, "planned", targetDate ?? null, now());
  logEvent(db, { actor: "owner", action: "release.create", detail: `${id} ${name}` });
  return getRelease(db, id);
}

export function planRelease(db, { id, tasks } = {}) {
  const r = getRelease(db, id);
  if (!r) fail("NOT_FOUND", `发布不存在：${id}`);
  if (r.status === "shipped") fail("E_ILLEGAL_TRANSITION", `${id} 已发布`);
  const list = Array.isArray(tasks) ? tasks.map(String) : [];
  if (!list.length) fail("E_CONTRACT", "plan 需要至少一个任务号");
  for (const taskId of list) {
    if (!taskExists(db, taskId)) fail("NOT_FOUND", `任务不存在：${taskId}`);
    db.prepare("INSERT OR IGNORE INTO release_tasks(release_id,task_id) VALUES(?,?)").run(id, taskId);
  }
  db.prepare("UPDATE releases SET status='building' WHERE id=? AND status='planned'").run(id);
  logEvent(db, { actor: "owner", action: "release.plan", detail: `${id} +${list.length}` });
  return getRelease(db, id);
}

/**
 * 发布门禁：挂进发布的任务全部 done、且没有别人的在办任务。
 *
 * 发布必须留下可回滚的点：一个指在「已验收的那一版」的提交 + 一个 tag。
 * 只有打了 tag，`git checkout <tag>` 才是真的回滚，而不是靠人回忆"那天发了啥"。
 */
export function shipRelease(db, { id, root } = {}) {
  const r = getRelease(db, id);
  if (!r) fail("NOT_FOUND", `发布不存在：${id}`);
  if (r.status === "shipped") fail("E_ILLEGAL_TRANSITION", `${id} 已经发布过`);
  if (!r.tasks.length) fail("E_RELEASE_EMPTY", `${id} 还没有挂任何任务`);
  if (r.pending) {
    fail("E_RELEASE_OPEN", `${id} 还有 ${r.pending} 个任务没完成`, {
      pending: r.tasks.filter((t) => t.status !== "done").map((t) => ({ id: t.id, status: t.status })),
    });
  }
  // 发布意味着"仓库这一版可以交付"：还挂在别人手上的任务会把半成品带上线
  const stillDoing = db.prepare("SELECT id, title FROM tasks WHERE status='doing' ORDER BY id").all();
  if (stillDoing.length) {
    fail("E_RELEASE_OPEN", `还有 ${stillDoing.length} 个任务正在做，先收口再发布`, { doing: stillDoing });
  }

  const weak = metaGet(db, "mode") === "weak";
  if (!root || weak) {
    // 弱模式没有 git，天生没有回滚点；说清楚，别让人以为能回滚
    const note = weak ? "弱模式（无 git）：没有可回滚的提交" : "没有仓库路径：没打 tag";
    db.prepare("UPDATE releases SET status='shipped', shipped_at=?, note=? WHERE id=?").run(now(), note, id);
    logEvent(db, { actor: "owner", action: "release.ship", detail: `${id} ${r.tasks.length} 个任务（${note}）` });
    return getRelease(db, id);
  }

  const sha = head(root);
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = String(r.title).trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || id;
  // 同名 tag 已存在就别覆盖：它可能是上一次真实发布的回滚点
  let tag = `release/${slug}-${stamp}`;
  for (let n = 2; tagExists(root, tag); n += 1) tag = `release/${slug}-${stamp}-${n}`;
  const message = `${id} ${r.title}\n\n${r.tasks.map((t) => `${t.id} ${t.title}`).join("\n")}`;
  try {
    git(root, ["tag", "-a", tag, "-m", message]);
  } catch (error) {
    // 打不上 tag 就不算发布：回滚点不存在，发出去也收不回来
    fail("E_RELEASE_TAG", `git tag 创建失败：${String(error.stderr ?? error.message).slice(0, 200)}`, { tag });
  }
  db.prepare("UPDATE releases SET status='shipped', shipped_at=?, git_tag=?, git_sha=? WHERE id=?").run(now(), tag, sha, id);
  logEvent(db, { actor: "owner", action: "release.ship", detail: `${id} ${r.tasks.length} 个任务 @ ${tag} (${sha.slice(0, 8)})` });
  return getRelease(db, id);
}

function tagExists(root, tag) {
  try {
    return git(root, ["tag", "-l", tag]).trim() === tag;
  } catch {
    return false;
  }
}

/** bootstrap 用：有在进行的发布就报一句，没有就 null */
export function releaseSummary(db) {
  // 还没挂任务的「草稿发布」不算当前发布，不往 bootstrap 里塞噪音
  const row = db
    .prepare(
      `SELECT id FROM releases r
        WHERE r.status IN ('planned','building')
          AND EXISTS (SELECT 1 FROM release_tasks rt WHERE rt.release_id = r.id)
        ORDER BY r.created_at DESC LIMIT 1`,
    )
    .get();
  if (!row) return null;
  const rel = getRelease(db, row.id);
  return {
    id: rel.id,
    title: rel.title,
    status: rel.status,
    targetDate: rel.target_date,
    pending: rel.pending,
    tasks: rel.tasks.slice(0, 8).map((t) => ({ id: t.id, status: t.status })),
    ready: rel.tasks.length > 0 && rel.pending === 0,
  };
}

export function assertReleaseStatus(status) {
  if (!RELEASE_STATUS.includes(status)) fail("E_CONTRACT", `未知发布状态：${status}`);
  return status;
}