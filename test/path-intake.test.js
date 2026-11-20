import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { bootstrap } from "../src/digest.js";
import { getPath, listPaths, pathIntake, reqApprove } from "../src/store.js";
import { makeRepo, initFlow, BIN } from "./helpers.js";

function fixture() {
  const root = makeRepo();
  const { db, reqId } = initFlow(root);
  return {
    root,
    db,
    reqId,
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    },
  };
}

test("Path intake creates a draft only; Owner approval remains the only contract freeze", () => {
  const f = fixture();
  try {
    const result = pathIntake(f.db, f.root, {
      requirementId: f.reqId,
      allowedPaths: ["docs/spikes/plugin-contract.mjs", "docs/spikes/plugin-contract.test.mjs"],
      allowNewFiles: true,
      budgetLines: 600,
      testCmds: ["node --test docs/spikes/plugin-contract.test.mjs", "git diff --check"],
    });

    assert.equal(result.id, "P-002");
    assert.equal(result.status, "draft");
    assert.equal(result.requiresOwnerApproval, true);
    assert.deepEqual(getPath(f.db, "P-002").allowedPaths, [
      "docs/spikes/plugin-contract.mjs",
      "docs/spikes/plugin-contract.test.mjs",
    ]);
    assert.equal(getPath(f.db, "P-002").status, "draft");
    assert.equal(getPath(f.db, "P-002").hash, null);
    assert.equal(getPath(f.db, "P-002").contract_commit, null);
    assert.equal(fs.existsSync(`${f.root}/.devcontrol/contracts/P-002.json`), false);
    assert.ok(f.db.prepare("SELECT 1 FROM events WHERE action='path.intake' AND detail LIKE 'P-002%'").get());
    assert.ok(bootstrap(f.db, f.root).actions.includes("path.create"));

    const approved = reqApprove(f.db, f.root, { requirementId: f.reqId, pathId: "P-002" });
    assert.equal(approved.pathId, "P-002");
    assert.equal(getPath(f.db, "P-002").status, "approved");
    assert.equal(getPath(f.db, "P-002").allow_new_files, 1);
    assert.equal(fs.existsSync(`${f.root}/.devcontrol/contracts/P-002.json`), true);
  } finally {
    f.cleanup();
  }
});

test("Path intake refuses paths outside the repository and malformed budgets/commands", () => {
  const f = fixture();
  try {
    const base = {
      requirementId: f.reqId,
      allowedPaths: ["src"],
      budgetLines: 600,
      testCmds: ["npm test"],
    };
    assert.throws(() => pathIntake(f.db, f.root, { ...base, allowedPaths: ["../outside"] }), (e) => e.code === "E_CONTRACT");
    assert.throws(() => pathIntake(f.db, f.root, { ...base, budgetLines: 99 }), (e) => e.code === "E_CONTRACT");
    assert.throws(() => pathIntake(f.db, f.root, { ...base, testCmds: [] }), (e) => e.code === "E_NO_TEST_CMD");
    assert.equal(listPaths(f.db).length, 1, "拒绝的草案不能留下半条 Path");
  } finally {
    f.cleanup();
  }
});

test("Path ID generation cannot collide when an old DB is missing counter:P", () => {
  const f = fixture();
  try {
    f.db.prepare("DELETE FROM meta WHERE key='counter:P'").run();
    const result = pathIntake(f.db, f.root, {
      requirementId: f.reqId,
      allowedPaths: ["docs"],
      budgetLines: 600,
      testCmds: ["npm test"],
    });
    assert.equal(result.id, "P-002");
    assert.equal(listPaths(f.db).length, 2);
  } finally {
    f.cleanup();
  }
});

test("CLI path create produces a draft and prints the Owner approval command", () => {
  const f = fixture();
  try {
    const run = spawnSync(process.execPath, [
      BIN, "path", "create",
      "--req", f.reqId,
      "--allow", "docs/spikes/plugin-contract.mjs",
      "--allow", "docs/spikes/plugin-contract.test.mjs",
      "--allow-new-files",
      "--budget", "600",
      "--test", "node --test docs/spikes/plugin-contract.test.mjs",
      "--test", "git diff --check",
    ], { cwd: f.root, encoding: "utf8", env: { ...process.env, DEVCONTROL_ROOT: f.root } });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /P-002/);
    assert.match(run.stdout, /尚未批准/);
    assert.match(run.stdout, /devcontrol approve FR-001 --path P-002/);
    assert.equal(getPath(f.db, "P-002").status, "draft");
  } finally {
    f.cleanup();
  }
});
