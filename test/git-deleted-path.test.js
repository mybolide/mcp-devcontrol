import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitFiles } from "../src/git.js";

test("scoped Git commits include deletion of a tracked file after moving reports", () => {
  // The smoke repo is disposable test data; keep it in the OS temp directory
  // instead of deriving a project root from the test file's nesting depth.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devcontrol-git-deletion-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "old-report.md"), "original\n");
    git("add", "old-report.md");
    git("-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-q", "-m", "base");
    fs.rmSync(path.join(repo, "old-report.md"));
    const sha = commitFiles(repo, ["old-report.md"], "docs: archive report");
    assert.ok(sha.length >= 40);
    assert.match(git("show", "--name-status", "--format=", "HEAD"), /D\s+old-report\.md/);
    assert.equal(git("status", "--porcelain"), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
