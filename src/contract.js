// devcontrol — Path 契约：批准时写入并提交，读取只从 git（不从工作树/DB）
import fs from "node:fs";
import path from "node:path";
import { commitFiles, git, showFile } from "./git.js";
import { dataDir } from "./db.js";
import { sha256 } from "./fingerprint.js";
import { buildStandards } from "./standards.js";

export function contractRel(pathId) {
  return `.devcontrol/contracts/${pathId}.json`;
}

export function contractBody({ pathId, requirementId, allowedPaths, allowNewFiles, testCmds, budgetLines, standards }) {
  return {
    pathId,
    requirementId: requirementId ?? null,
    allowedPaths,
    allowNewFiles: Boolean(allowNewFiles),
    testCmds,
    budgetLines,
    // 规范也冻进契约：Owner 批准时看得见，Agent claim 时拿得到，被拦时能对上号。
    // 这是「比 Jira 强一点」的那一半——Jira 只有验收，没有「代码该怎么写」。
    standards: standards ?? buildStandards({ budgetLines }),
    note: "批准时冻结；Agent 只读，改动必须由 Owner 重新批准",
  };
}

/**
 * 写入契约文件并提交，返回 { sha, hash }；verb=approve|amend 参与提交信息前缀。
 * 内容没变时不产生空提交（例如 amend 只改验收标准），直接复用 HEAD。
 */
export function commitContract(root, body, verb = "approve", { weak = false } = {}) {
  const rel = contractRel(body.pathId);
  const abs = path.join(root, rel);
  const text = JSON.stringify(body, null, 2) + "\n";
  const hash = sha256(Buffer.from(text));
  let existing = null;
  try {
    existing = showFile(root, "HEAD", rel);
  } catch {
    existing = null;
  }
  if (weak) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
    return { sha: null, hash };
  }
  if (existing === text) return { sha: git(root, ["rev-parse", "HEAD"]).trim(), hash };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
  const sha = commitFiles(root, [rel], `chore(devcontrol): ${verb} ${body.pathId}`);
  return { sha, hash };
}

/** 从某个提交读契约并校验哈希 */
export function readContract(root, commit, pathId, expectedHash) {
  const rel = contractRel(pathId);
  let text;
  if (!commit) {
    // 弱模式（无 git）：契约只存在于工作树
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) throw Object.assign(new Error(`E_NO_CONTRACT: ${rel} 不存在`), { code: "E_NO_CONTRACT" });
    text = fs.readFileSync(abs, "utf8");
  } else {
    try {
      text = showFile(root, commit, rel);
    } catch {
      throw Object.assign(new Error(`E_NO_CONTRACT: ${commit}:${rel} 不存在`), { code: "E_NO_CONTRACT" });
    }
  }
  const hash = sha256(Buffer.from(text));
  if (expectedHash && hash !== expectedHash) {
    throw Object.assign(new Error(`E_CONTRACT: 契约哈希不符（期望 ${expectedHash.slice(0, 8)}，实际 ${hash.slice(0, 8)}）`), {
      code: "E_CONTRACT",
    });
  }
  return { body: JSON.parse(text), hash };
}

export function contractExists(root, commit, pathId) {
  try {
    showFile(root, commit, contractRel(pathId));
    return true;
  } catch {
    return false;
  }
}

/** 契约里的命令白名单 */
export function contractCommands(body) {
  return Array.isArray(body.testCmds) ? body.testCmds : [];
}

/** 断言只能这么写：把写法本身摆出来，比说「缺 ::」有用 */
export const ASSERTION_HELP =
  '断言格式：<命令> :: <谓词>，例如 `npm test :: exit==0`、`npm run build :: exit==0`、`make lint :: stdout =~ /0 problems/`（谓词只有两种：exit==0 和 stdout =~ /正则/）';

export function parseAssertion(assertion) {
  const text = String(assertion ?? "").trim();
  const idx = text.indexOf("::");
  if (idx < 0) {
    throw Object.assign(new Error(`E_CONTRACT: 断言缺少 "::"：${text}。${ASSERTION_HELP}`), {
      code: "E_CONTRACT",
      data: { assertion: text, help: ASSERTION_HELP },
    });
  }
  const command = text.slice(0, idx).trim();
  const predicate = text.slice(idx + 2).trim();
  if (!command || !predicate) {
    throw Object.assign(new Error(`E_CONTRACT: 断言格式不合法：${text}。${ASSERTION_HELP}`), {
      code: "E_CONTRACT",
      data: { assertion: text, help: ASSERTION_HELP },
    });
  }
  // 谓词写错最难自己发现：它要到收口比对时才炸，而那时人会以为是测试没过。
  // 所以在这里就拦住，并把两种合法写法报给他。
  if (!/^exit\s*==\s*\d+$/.test(predicate) && !/^stdout\s*=~\s*\/.*\/[a-z]*$/s.test(predicate)) {
    throw Object.assign(new Error(`E_CONTRACT: 谓词不认识：${predicate}。${ASSERTION_HELP}`), {
      code: "E_CONTRACT",
      data: { assertion: text, predicate, help: ASSERTION_HELP },
    });
  }
  return { command, predicate };
}

export function isContractDir(file) {
  return file.startsWith(".devcontrol/contracts/");
}

export { dataDir };