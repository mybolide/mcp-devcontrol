import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, SCHEMA_VERSION } from "../src/db.js";
import { validateCompletionInput, insertCompletion, listCompletions } from "../src/completion.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devcontrol-completion-"));
  const db = openDb(root);
  return {
    root,
    db,
    close() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

const valid = { summary: "加入分层缓存", changes: "新增读取缓存与失效测试", limitations: "无" };

test("completion migration is schema v6, idempotent, and does not invent legacy history", () => {
  const f = fixture();
  try {
    assert.equal(SCHEMA_VERSION, 6);
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "6");
    f.db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
    f.db.exec("CREATE TABLE IF NOT EXISTS task_completions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, sequence INTEGER NOT NULL, actor TEXT NOT NULL, closed_at TEXT NOT NULL, closed_by TEXT NOT NULL, summary TEXT NOT NULL, changes TEXT NOT NULL, limitations TEXT NOT NULL, fingerprint TEXT, runs_json TEXT NOT NULL DEFAULT '[]', commits_json TEXT NOT NULL DEFAULT '[]', UNIQUE(task_id, sequence))");
    // Reopening through the idempotent DDL/migration path must preserve existing history.
    f.db.prepare("INSERT INTO task_completions(id,task_id,sequence,actor,closed_at,closed_by,summary,changes,limitations) VALUES('legacy-row','T-OLD',1,'old-agent','2026-01-01T00:00:00.000Z','evidence','old summary','old changes','old limits')").run();
    f.db.close();
    const reopened = openDb(f.root);
    try {
      assert.equal(reopened.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "6");
      // 老记录没有 delivery 这一列，迁移只补列、不猜历史：一律按 code 解释
      assert.equal(listCompletions(reopened, "T-OLD")[0].delivery, "code");
      assert.equal(listCompletions(reopened, "T-OLD")[0].summary, "old summary");
      assert.equal(listCompletions(reopened, "T-UNRECORDED").length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    try { f.db.close(); } catch { /* already closed above */ }
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("normal close completion fields reject missing, whitespace, non-string, and over-limit values", () => {
  assert.deepEqual(validateCompletionInput(valid), valid);
  for (const patch of [
    { summary: undefined },
    { changes: " \n " },
    { limitations: 1 },
    { summary: "x".repeat(4001) },
    { changes: "x".repeat(16001) },
    { limitations: "x".repeat(8001) },
  ]) {
    assert.throws(() => validateCompletionInput({ ...valid, ...patch }), (error) => error.code === "E_NEED_COMPLETION");
  }
});

test("completion history is append-only, sequences each task, and snapshots supplied verified evidence", () => {
  const f = fixture();
  try {
    const input = validateCompletionInput(valid);
    const first = insertCompletion(f.db, {
      taskId: "T-001", actor: "agent-a", closedAt: "2026-01-01T00:00:00.000Z", closedBy: "evidence",
      ...input, fingerprint: "fp-1",
      runs: [{ runId: "run-1", command: "npm test", exitCode: 0, head: "abc", fingerprint: "fp-1", logSha256: "hash-1" }],
      commits: [{ sha: "1234567890abcdef1234567890abcdef12345678", taskId: "T-001", patch: "patch-1", files: ["src/cache.js"] }],
    });
    const second = insertCompletion(f.db, {
      taskId: "T-001", actor: "agent-b", closedAt: "2026-01-02T00:00:00.000Z", closedBy: "evidence",
      summary: "补充失效边界", changes: "缓存失效与回归测试", limitations: "无", fingerprint: "fp-2",
      runs: [{ runId: "run-2", command: "npm test", exitCode: 0, head: "def", fingerprint: "fp-2", logSha256: "hash-2" }],
      commits: [{ sha: "abcdef1234567890abcdef1234567890abcdef12", taskId: "T-001", files: ["src/cache.js"] }],
    });
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    const history = listCompletions(f.db, "T-001");
    assert.deepEqual(history.map((entry) => entry.id), [second.id, first.id]);
    assert.equal(history[0].runs[0].head, "def");
    assert.equal(history[0].commits[0].taskId, "T-001");
    assert.throws(() => f.db.prepare("UPDATE task_completions SET summary='rewrite' WHERE id=?").run(first.id));
    assert.throws(() => f.db.prepare("DELETE FROM task_completions WHERE id=?").run(first.id));
    assert.equal(listCompletions(f.db, "T-001").length, 2);
  } finally {
    f.close();
  }
});
