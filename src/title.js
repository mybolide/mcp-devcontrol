// devcontrol — 把验收命令翻成一句人话标题
//
// 任务标题是要给人看的第一行。以前 next 直接把断言拼上去：
//   「覆盖验收：cargo clippy --workspace --locked --all-targets -- -D warnings :: exit==0」
// 人一眼读不出这活到底做什么，得自己在脑子里解析参数。下面这层翻译负责这件事——
// 命令与 deriveFrom 仍然原样记在任务里（机器认这个），人看的是标题。

/** 从命令里挑出 crate / 目录这类「主语」。 */
function subject(command) {
  const text = String(command ?? "");
  const pkg = text.match(/(?:^|\s)(?:-p|--package)[=\s]+([^\s"']+)/)?.[1];
  if (pkg) return pkg;
  const prefix = text.match(/--prefix\s+([^\s"']+)/)?.[1];
  if (prefix) return prefix.replace(/\/+$/, "");
  return null;
}

/**
 * 一条断言 → 一句人话标题。
 * 认不出来的命令退回「跑通 <命令>」，不硬编、也不假装懂。
 */
export function humanAssertionTitle(assertion) {
  const raw = String(assertion ?? "").trim();
  const command = raw.split("::")[0].trim();
  if (!command) return "补一条验收";
  const who = subject(command);

  if (/^cargo\s+clippy\b/.test(command)) return who ? `${who} 的 Clippy 零告警` : "Clippy 零告警";
  if (/^cargo\s+test\b/.test(command)) return who ? `跑通 ${who} 的测试` : "跑通 Rust 测试（全工作区）";
  if (/^cargo\s+(build|check)\b/.test(command)) return who ? `编译通过（${who}）` : "编译通过";
  if (/^git\s+diff\s+--check\b/.test(command)) return "改动里没有空白错误";
  if (/^node\s+--test\b/.test(command)) {
    const file = command.match(/--test\s+(\S+)/)?.[1];
    return file ? `跑通 ${file}` : "跑通 Node 测试";
  }
  if (/^npm\s+--prefix\s+\S+\s+run\s+build\b/.test(command)) return `构建 ${who ?? "前端"}`;
  if (/^npm\s+(run\s+)?test\b/.test(command)) return "跑通单元测试";
  if (/^npm\s+run\s+build\b/.test(command)) return "构建通过";
  if (/^pnpm\s+test\b/.test(command)) return "跑通单元测试";
  if (/^pytest\b/.test(command)) return "跑通 Python 测试";
  if (/^go\s+test\b/.test(command)) return "跑通 Go 测试";
  if (/^mvn\b|^gradle\b/.test(command)) return "跑通 Java 构建与测试";
  // 认不出来就老实说：跑通这条命令，括号里给原文，人还能自己判断
  const short = command.length > 60 ? `${command.slice(0, 57)}…` : command;
  return `跑通 ${short}`;
}