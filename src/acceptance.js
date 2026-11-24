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

/** 把命令里出现的仓库路径挑出来（`npm --prefix apps/desktop run build` → apps/desktop）。 */
export function commandPaths(command) {
  const out = new Set();
  const text = String(command ?? "");
  // --prefix <dir> / -C <dir> / 显式 ./ 或 目录/文件 形式的参数
  for (const m of text.matchAll(/--prefix\s+([^\s"']+)/g)) out.add(m[1].replace(/^\.\//, ""));
  for (const m of text.matchAll(/\s-C\s+([^\s"']+)/g)) out.add(m[1].replace(/^\.\//, ""));
  for (const m of text.matchAll(/(?:^|\s)(\.\/[^\s"']+|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]+)+)/g)) {
    const v = m[1].replace(/^\.\//, "");
    if (!v.startsWith("-") && !/^\d/.test(v)) out.add(v);
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
