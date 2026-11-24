// devcontrol — 验收继承：三级（Requirement / Path / Task）
//
// 现实里一条需求会拆成几个阶段，每个阶段有自己的 Path 和**自己的验收命令**：
// FR-007 的 P-006 干 ACP + Desktop，命令里有 `cargo test -p agent-studio-acp`、
// `npm --prefix apps/desktop run build`；而 P-007 只干 provider 契约，命令是
// `cargo test --workspace`。早先建任务时，「没写 --accept 就用 Path 的第一条命令」，
// 而 Path 常常带着上一阶段留下来的一串命令——于是 P-007 的任务被迫去跑 ACP 与
// Desktop 的构建，跑不过就只能挂起等 Owner。
//
// 这里的规矩：
//   · 任务的验收默认继承**它自己那条 Path** 的冻结命令，绝不跨 Path 继承；
//   · 任务显式给的命令必须是这条 Path 冻结过的（契约白名单，已有门禁）；
//   · 命令与 scope 明显对不上时给一条诊断（不拦，因为「跑整个工作区的测试、
//     只改一个 crate」是常态；但「只授权 docs/** 却要跑 apps/desktop 构建」不像话）。
import { assertionCommand } from "./testcmd.js";
import fs from "node:fs";
import path from "node:path";

/**
 * crate 名 → 仓库内目录（只读扫 Cargo.toml，不走网络）。
 *
 * 为什么需要：`cargo test -p agent-studio-acp` 里没有仓库路径，只有 crate 名。
 * 不把它翻成目录，「这条命令碰了哪」就算不出来——体检会把最常见的一类 Rust
 * 命令整类漏掉（P-002 身上那串 `-p agent-studio-acp` 就是这么溜过去的）。
 * 按 root 缓存：一次进程内只扫一遍。
 */
const CRATE_CACHE = new Map();
export function crateDirs(root) {
  const key = path.resolve(String(root ?? "."));
  if (CRATE_CACHE.has(key)) return CRATE_CACHE.get(key);
  const map = new Map();
  const skip = new Set(["target", "node_modules", ".git", ".devcontrol", "dist", "build", ".venv"]);
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const toml = path.join(abs, "Cargo.toml");
      if (fs.existsSync(toml)) {
        try {
          const text = fs.readFileSync(toml, "utf8");
          // 只认 [package] 段里的 name，别把 [workspace.package] 或依赖名当 crate 名
          const section = text.split(/^\[/m).find((s) => s.startsWith("package]"));
          const name = section?.match(/\bname\s*=\s*"([^"]+)"/)?.[1];
          if (name && !map.has(name)) map.set(name, path.relative(key, abs).replace(/\\/g, "/") || ".");
        } catch {
          /* 读不了就当不知道：诊断少一条，也不能因此拦人 */
        }
      }
      walk(abs, depth + 1);
    }
  };
  walk(key, 0);
  CRATE_CACHE.set(key, map);
  return map;
}

/** 把命令里出现的仓库路径挑出来（`npm --prefix apps/desktop run build` → apps/desktop）。 */
export function commandPaths(command, { crates = null } = {}) {
  const out = new Set();
  const text = String(command ?? "");
  // --prefix <dir> / -C <dir> / 显式 ./ 或 目录/文件 形式的参数
  for (const m of text.matchAll(/--prefix\s+([^\s"']+)/g)) out.add(m[1].replace(/^\.\//, ""));
  for (const m of text.matchAll(/\s-C\s+([^\s"']+)/g)) out.add(m[1].replace(/^\.\//, ""));
  for (const m of text.matchAll(/(?:^|\s)(\.\/[^\s"']+|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]+)+)/g)) {
    const v = m[1].replace(/^\.\//, "");
    if (!v.startsWith("-") && !/^\d/.test(v)) out.add(v);
  }
  // cargo 的 -p / --package 只给 crate 名：有映射表才翻得出目录，翻不出来就不猜
  if (crates) {
    for (const m of text.matchAll(/(?:^|\s)(?:-p|--package)[=\s]+([^\s"']+)/g)) {
      const dir = typeof crates.get === "function" ? crates.get(m[1]) : crates[m[1]];
      if (dir) out.add(dir);
    }
  }
  return [...out].filter((p) => p && p !== "." && !/^(cargo|npm|node|pnpm|yarn)$/.test(p));
}

/** 某个路径是否落在 scope 里（scope 支持 `dir`、`dir/**`、具体文件、`.`）。 */
export function pathInScope(file, scope) {
  const norm = (v) => String(v).replace(/\/+$/, "").replace(/\/\*\*?$/, "");
  return (scope ?? []).some((s) => {
    const base = norm(s);
    if (!base || base === ".") return true;
    const f = norm(file);
    return f === base || f.startsWith(`${base}/`) || base.startsWith(`${f}/`);
  });
}

/**
 * 建任务时的验收/范围体检。返回 warnings（不拦），每条都带一句「怎么改」。
 * 拦的只有一件事，而那件事在契约层就拦死了（命令不在白名单 → E_CONTRACT）。
 */
export function acceptScopeWarnings({ acceptance, scope, path } = {}) {
  const list = (acceptance ?? []).map((a) => assertionCommand(String(a?.assertion ?? ""))).filter(Boolean);
  const pathId = path?.id ?? "这条 Path";
  const warnings = [];
  const outside = new Map();
  for (const command of list) {
    for (const p of commandPaths(command)) {
      if (!pathInScope(p, scope)) outside.set(p, command);
    }
  }
  if (outside.size) {
    warnings.push({
      id: "accept-scope-mismatch",
      detail: `验收命令碰的路径不在任务 scope 里：${[...outside.entries()].map(([p, c]) => `${p}（${c}）`).join("、")}`,
      fix: `要么把 scope 放宽到覆盖这些目录（仍受 ${pathId} 授权范围限制），要么把这条命令从任务验收里去掉——它的阶段应该在另一条 Path 上`,
    });
  }
  const onlyGlobal = list.filter((c) => !commandPaths(c).length && /\bworkspace\b/.test(c));
  if (onlyGlobal.length && (scope ?? []).length && (scope ?? []).length > 2) {
    warnings.push({
      id: "accept-too-broad",
      detail: `${onlyGlobal.join("、")} 跑的是整个仓库，而这个任务的 scope 只有 ${scope.length} 处`,
      fix: "能收窄就收窄（例如 cargo test -p <crate>）；收不窄也没关系——全量跑通比只跑一处更有说服力",
    });
  }
  return warnings;
}
