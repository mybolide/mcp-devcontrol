// devcontrol — 把内核的 next 翻成能直接粘贴执行的命令行
//
// 为什么需要这一层：SKILL 里写着「按 next.args 原样执行（参数是给全的）」，
// 但 next 给的是 MCP 的参数名（requirementId / pathId / acceptance），
// 纯 CLI 用户拿到的是一坨 JSON，得自己把 requirementId 手动翻成 --req、
// 把 acceptance 数组翻成重复的 --accept。这不叫「给全了」，叫「给了原料」。
//
// 所以内核自己算命令：它知道两边的对应关系，让 Agent 少做一次翻译，
// 就少一次翻错的机会（T-102）。

/**
 * shell 引号：参数里常有中文标题、`::`、空格，裸拼会被 shell 拆开。
 *
 * 引号按平台选，不能一律单引号：Windows 的 cmd.exe 不认单引号，它会把 `'x'`
 * 连引号一起交给程序——`--title '覆盖验收：npm test :: exit==0'` 于是被拆成
 * `--title` + `'覆盖验收：npm` + `test` + `::` + `exit==0'`，内核报的是
 * `E_CONTRACT: 断言缺少 "::"`，报错和真因差着三条街（T-102 的同一个坑）。
 * POSIX 侧保持单引号：双引号里 `$`、反引号仍会展开，标题里带这些字符就会走样。
 */
export function quote(value) {
  const s = String(value);
  if (/^[A-Za-z0-9_.,:=/@%+-]+$/.test(s)) return s;
  if (process.platform === "win32") return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);

/**
 * action + args → 一行可执行的 devcontrol 命令。
 * 不认识的 action 返回 null：宁可什么都不说，也不要编一条跑不通的命令。
 */
export function cliCommand(action, args = {}) {
  switch (action) {
    case "task.create": {
      const parts = ["devcontrol", "task", "create"];
      if (args.requirementId) parts.push("--req", quote(args.requirementId));
      if (args.pathId) parts.push("--path", quote(args.pathId));
      if (args.kind) parts.push("--kind", quote(args.kind));
      if (args.title) parts.push("--title", quote(args.title));
      const scope = list(args.scope);
      if (scope.length) parts.push("--scope", quote(scope.join(",")));
      for (const a of list(args.acceptance)) {
        const assertion = typeof a === "string" ? a : a?.assertion;
        if (assertion) parts.push("--accept", quote(assertion));
      }
      const deps = list(args.dependsOn);
      if (deps.length) parts.push("--depends", quote(deps.join(",")));
      return parts.join(" ");
    }
    case "task.claim":
      return args.id ? `devcontrol task claim ${quote(args.id)}` : null;
    case "task.close":
      return args.id ? `devcontrol close ${quote(args.id)}` : null;
    case "task.renew":
      return args.id ? `devcontrol renew ${quote(args.id)}` : null;
    case "evidence.record":
      // 证据是「自己跑完再交」：命令原文照抄，别的（退出码）内核自己读
      return args.command ? `devcontrol run -- ${args.command}` : null;
    default:
      return null;
  }
}
