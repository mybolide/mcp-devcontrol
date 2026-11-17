// devcontrol — SQLite 存储层（M0-lite / 9 表）
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 4;
export const DATA_DIR = ".devcontrol";
export const DB_FILE = "state.db";

export function dataDir(root) {
  return path.join(root, DATA_DIR);
}
export function dbPath(root) {
  return path.join(dataDir(root), DB_FILE);
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requirements(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
  acceptance_json TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, approved_at TEXT, archived_at TEXT);
CREATE TABLE IF NOT EXISTS paths(
  id TEXT PRIMARY KEY, requirement_id TEXT,
  allowed_paths_json TEXT NOT NULL, allow_new_files INTEGER NOT NULL DEFAULT 0,
  budget_lines INTEGER NOT NULL DEFAULT 1200, test_cmds_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL, hash TEXT, contract_commit TEXT, approved_at TEXT);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, path_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  scope_json TEXT NOT NULL, acceptance_json TEXT NOT NULL, depends_on_json TEXT NOT NULL DEFAULT '[]',
  budget_lines INTEGER NOT NULL DEFAULT 1200, changed_lines INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 0,
  base_head TEXT NOT NULL, contract_hash TEXT NOT NULL, contract_commit TEXT NOT NULL,
  claimed_by TEXT, claimed_at TEXT, claim_expires_at TEXT,
  closing_at TEXT, closing_token TEXT, claim_fingerprint TEXT,
  review_round INTEGER NOT NULL DEFAULT 0, closed_by TEXT, closed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
CREATE TABLE IF NOT EXISTS bugs(
  id TEXT PRIMARY KEY, requirement_id TEXT, title TEXT NOT NULL,
  symptom TEXT NOT NULL, expected TEXT NOT NULL, repro_json TEXT NOT NULL DEFAULT '[]',
  attachments_json TEXT NOT NULL DEFAULT '[]', severity TEXT NOT NULL DEFAULT 'P2',
  status TEXT NOT NULL, task_id TEXT, source TEXT NOT NULL,
  closed_by TEXT, created_at TEXT NOT NULL, archived_at TEXT);
CREATE TABLE IF NOT EXISTS docs(
  id TEXT PRIMARY KEY, requirement_id TEXT, path TEXT NOT NULL,
  sha256 TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, registered_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS questions(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, question TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]', answer TEXT, answered_at TEXT,
  status TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  channel TEXT NOT NULL, action TEXT NOT NULL, task_id TEXT, code TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, assertion_idx INTEGER NOT NULL,
  command TEXT NOT NULL, exit_code INTEGER NOT NULL, head TEXT NOT NULL,
  fingerprint TEXT NOT NULL, log_sha256 TEXT NOT NULL, output TEXT NOT NULL,
  started_at TEXT NOT NULL, duration_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS patch_ids(
  patch_id TEXT NOT NULL, task_id TEXT NOT NULL, commit_sha TEXT NOT NULL,
  PRIMARY KEY(patch_id, task_id));
CREATE TABLE IF NOT EXISTS releases(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned',
  target_date TEXT, created_at TEXT NOT NULL, shipped_at TEXT,
  git_tag TEXT, git_sha TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS release_tasks(
  release_id TEXT NOT NULL, task_id TEXT NOT NULL,
  PRIMARY KEY(release_id, task_id));
CREATE INDEX IF NOT EXISTS ix_releases_status ON releases(status);
CREATE INDEX IF NOT EXISTS ix_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS ix_tasks_doing ON tasks(status, claim_expires_at);
CREATE INDEX IF NOT EXISTS ix_tasks_req ON tasks(requirement_id);
CREATE INDEX IF NOT EXISTS ix_events_at ON events(at);
CREATE INDEX IF NOT EXISTS ix_events_task ON events(task_id, at);
CREATE INDEX IF NOT EXISTS ix_questions_open ON questions(status, expires_at);
CREATE INDEX IF NOT EXISTS ix_bugs_status ON bugs(status);
`;

export function openDb(root) {
  const file = dbPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // busy_timeout 必须在 WAL 之前：切 WAL 需要独占锁，超时为 0 时并发打开会直接 SQLITE_BUSY
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(DDL);
  migrate(db);
  return db;
}

/**
 * 老库升级：只做加列/加表这类向后兼容的动作，必须能重复执行——每次 openDb 都会过一遍。
 */
function migrate(db) {
  const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  const from = cur ? Number(cur.value) : 0;
  if (from > SCHEMA_VERSION) {
    const err = new Error(`库版本 ${from} > 程序版本 ${SCHEMA_VERSION}，请升级 devcontrol`);
    err.code = "E_SCHEMA_NEWER";
    throw err;
  }
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  // v2 → v3：发布要能指回一个可回滚的提交
  if (from < 3) {
    const c = cols("releases");
    for (const [name, type] of [["git_tag", "TEXT"], ["git_sha", "TEXT"], ["note", "TEXT"]]) {
      if (!c.has(name)) db.exec(`ALTER TABLE releases ADD COLUMN ${name} ${type}`);
    }
  }
  // v3 → v4：任务要有先后顺序（Backlog 的顺序就是优先级）
  if (from < 4 && !cols("tasks").has("rank")) {
    db.exec("ALTER TABLE tasks ADD COLUMN rank INTEGER NOT NULL DEFAULT 0");
  }
  if (!cur) db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  else db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION));
  return db;
}

export function metaGet(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
  return row ? row.value : null;
}
export function metaSet(db, key, value) {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
}

/** 单调 ID：在事务内取号，删除不回收 */
export function nextId(db, prefix) {
  const key = `counter:${prefix}`;
  const cur = Number(metaGet(db, key) ?? 0);
  const next = cur + 1;
  if (next > 99999) throw Object.assign(new Error("E_ID_EXHAUSTED"), { code: "E_ID_EXHAUSTED" });
  metaSet(db, key, next);
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

const BUSY_RETRIES = 5;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 写事务（BEGIN IMMEDIATE），失败回滚，成功提交。
 * BEGIN 遇到 SQLITE_BUSY 会有限重试——写者可能正在跑 git 子进程，5s 的 busy_timeout 不够稳。
 */
export function tx(db, fn) {
  let attempt = 0;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
      break;
    } catch (error) {
      const busy = String(error.message ?? "").includes("locked") || String(error.message ?? "").includes("busy");
      if (!busy || attempt >= BUSY_RETRIES) throw error;
      attempt += 1;
      sleepSync(80 * attempt);
    }
  }
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

/** 事务里禁止做慢操作（git 子进程、网络）：给调用方一个显式断言 */
export function assertNoSlowWork(what) {
  throw Object.assign(new Error(`E_INTERNAL: ${what} 不能放在数据库事务里`), { code: "E_INTERNAL" });
}

/**
 * 记一条事件。
 *
 * actor 没有默认值：这个字段只有两个字——「谁干的」——默认成 system 等于没写。
 * 早先它默认 system，于是 24 个调用点静默留白，周报的「按人」一栏全是 system（T-088/T-089）。
 * 现在漏传直接崩：新加事件忘了填，npm test 第一轮就红，不用等下次压测才发现。
 *
 * Owner 的动作传 "owner"，系统自己的动作（如过期回收）传 "system"，其余传 Agent 标识。
 */
export function logEvent(db, { actor, channel = "agent", action, taskId = null, code = null, detail = "" }) {
  if (!actor) throw new Error(`logEvent 缺 actor：事件「${action}」必须记到谁头上（Owner→"owner"、系统→"system"）`);
  db.prepare("INSERT INTO events(at,actor,channel,action,task_id,code,detail) VALUES(?,?,?,?,?,?,?)")
    .run(new Date().toISOString(), actor, channel, action, taskId, code, String(detail).slice(0, 300));
}