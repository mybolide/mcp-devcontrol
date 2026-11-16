// devcontrol — 验收命令从哪来：从项目里「现在」的样子采，而不是 init 那一刻定死
//
// 契约里冻结的 testCmds 是白名单，但项目会变：test 脚本从 `node --test tests/` 换成
// `node --test`，或者从 npm 换成 pnpm。命令一旦过期，收口跑的就是一条已经不存在的命令，
// Agent 只能干瞪眼。所以这里提供「重新采一次」的能力，doctor 用它检测漂移。
import fs from "node:fs";
import path from "node:path";

const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const has = (root, name) => fs.existsSync(path.join(root, name));

/** 按仓库里的锁文件判断该用哪个包管理器跑 test 脚本 */
function packageManager(root) {
  if (has(root, "pnpm-lock.yaml") || has(root, "pnpm-workspace.yaml")) return "pnpm";
  if (has(root, "yarn.lock")) return "yarn";
  if (has(root, "bun.lockb") || has(root, "bun.lock")) return "bun";
  return "npm";
}

/**
 * 采「这个仓库现在该用什么命令验收」。
 * 返回 { cmds: string[], source: string, note?: string }；采不到就 cmds 为空。
 *
 * 顺序刻意是「显式的 test 脚本 → 各语言的事实标准 → 什么都没有」：
 * 猜错命令比没有命令更糟——Agent 会以为验收跑过了。
 */
export function detectTestCmds(root) {
  const pkgRaw = read(path.join(root, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const script = String(pkg.scripts?.test ?? "").trim();
      if (script) {
        const pm = packageManager(root);
        // 记 `npm test` 而不是脚本原文：脚本内容可以随时改（换 runner、加参数），
        // 契约冻的是「用项目的 test 脚本验收」这件事，不是那一刻的字符串。
        return { cmds: [`${pm} test`], source: `package.json scripts.test（${pm} test）` };
      }
      if (String(pkg.scripts?.vitest ?? "").trim()) return { cmds: ["npx vitest run"], source: "package.json scripts.vitest" };
      if (String(pkg.scripts?.jest ?? "").trim()) return { cmds: ["npx jest"], source: "package.json scripts.jest" };
    } catch {
      return { cmds: [], source: "package.json 解析失败", note: "package.json 不是合法 JSON，先修它" };
    }
  }

  if (has(root, "Cargo.toml")) return { cmds: ["cargo test"], source: "Cargo.toml" };
  if (has(root, "go.mod")) return { cmds: ["go test ./..."], source: "go.mod" };
  if (has(root, "pytest.ini") || has(root, "pyproject.toml") || has(root, "tox.ini")) {
    return { cmds: ["pytest -q"], source: "Python 项目配置" };
  }
  const makefile = read(path.join(root, "Makefile"));
  if (makefile && /^test:/m.test(makefile)) return { cmds: ["make test"], source: "Makefile 的 test 目标" };

  return { cmds: [], source: "没有找到可用的验收命令", note: "在控制台给这条 Path 填一条（例如 npm test）" };
}

/**
 * 验收断言形如 `命令 :: 谓词`。命令过期时只换命令，谓词原样保留——
 * 谓词是 Owner 批准过的「怎样算通过」，改它就是改验收标准，那得走 req.amend。
 */
export function retargetAssertion(assertion, command) {
  const text = String(assertion ?? "");
  const idx = text.indexOf("::");
  if (idx < 0) return text;
  const predicate = text.slice(idx + 2).trim();
  return `${command} :: ${predicate}`;
}

/** 从断言里取命令部分（宽松解析：解析不了返回 null，交给上层决定） */
export function assertionCommand(assertion) {
  const idx = String(assertion ?? "").indexOf("::");
  return idx < 0 ? null : String(assertion).slice(0, idx).trim();
}