// devcontrol — 项目内版本锁入口（`.devcontrol/bin/`）
//
// 为什么要有：`devcontrol` 走 MCP 时由客户端拉起，但下面三种场景客户端帮不上忙：
//   1. 客户端掉了 MCP 工具租约（工具列表变了/超时），Agent 手上只剩 shell；
//   2. 项目本来就是纯 CLI 模式（`init --no-mcp`），没有 MCP 进程；
//   3. CI 或人自己要在终端里敲，但机器上没全局装 devcontrol。
// 这时如果只写「去跑 devcontrol」，实际执行的是**哪一份、哪个版本**没人说得清。
//
// 所以 init 在项目里落三个薄壳（sh / cmd / ps1），版本写死在文件里，
// 按「显式指定 → 本项目安装 → 锁定版本的 npx」顺序找入口，找不到就报清楚。
// 壳里不放任何业务逻辑：改了内核不会让壳过期，只有版本号变了才会重写。
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "./protocol.js";

/** 入口所在目录（相对项目根） */
export const WRAPPER_DIR = ".devcontrol/bin";

/** 三个平台的入口文件名 */
export const WRAPPER_FILES = ["devcontrol", "devcontrol.cmd", "devcontrol.ps1"];

/** npm 包名（写死在壳里，避免运行时去读 package.json） */
export const PACKAGE = "mcp-devcontrol";

/** 版本标记行：壳是被谁生成的就写在第一行注释里，用来判断要不要重写 */
const MARK = "devcontrol-cli-version";

const spec = `${PACKAGE}@${VERSION}`;

/**
 * 三份壳都遵守同一套解析顺序：
 *   ① `DEVCONTROL_LOCAL_ENTRY`（开发/自测指向本地 checkout）
 *   ② 本项目 node_modules 里的安装（build 产物优先，源码次之）
 *   ③ `npx --yes --cache <本地缓存> <包名>@<锁定版本>`
 * 缓存目录放在项目外（系统缓存），避免把 node_modules 拉进项目。
 */
function shBody() {
  return `#!/usr/bin/env sh
# ${MARK}: ${VERSION}
# 项目内版本锁入口：没接 MCP 的客户端、CI、或者人自己，都能打到同一套内核。
set -eu

WRAPPER_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
CACHE_ROOT="\${DEVCONTROL_NPX_CACHE:-\${XDG_CACHE_HOME:-$HOME/.cache}/devcontrol/npm-cache}"

if [ -n "\${DEVCONTROL_LOCAL_ENTRY:-}" ]; then
  exec node "$DEVCONTROL_LOCAL_ENTRY" "$@"
fi

for ENTRY in \\
  "$WRAPPER_ROOT/node_modules/${PACKAGE}/build/devcontrol.js" \\
  "$WRAPPER_ROOT/node_modules/${PACKAGE}/bin/devcontrol.js"; do
  if [ -f "$ENTRY" ]; then
    exec node "$ENTRY" "$@"
  fi
done

exec npx --yes --cache "$CACHE_ROOT" "${spec}" "$@"
`;
}

// 注意：`.cmd` / `.ps1` 里的注释必须是纯 ASCII。
// cmd.exe 按 OEM 代码页读批处理，UTF-8 中文会被切成半截命令
// （实测报 `'口：没接' is not recognized`）；PowerShell 5.1 无 BOM 时按 ANSI 读，同一个坑。
function cmdBody() {
  // 用 goto 而不是 if 块：cmd 的 %ERRORLEVEL% 在块里是解析期展开的，
  // 块内 `exit /b %ERRORLEVEL%` 拿到的是进块之前的值，退出码会错。
  return `@echo off
rem ${MARK}: ${VERSION}
rem Project-local version-locked entry point. Details: .devcontrol/bin/devcontrol
setlocal
for %%I in ("%~dp0..\\..") do set "DEVCONTROL_WRAPPER_ROOT=%%~fI"
if not defined DEVCONTROL_NPX_CACHE set "DEVCONTROL_NPX_CACHE=%LOCALAPPDATA%\\devcontrol\\npm-cache"

if not defined DEVCONTROL_LOCAL_ENTRY goto :devcontrol_local_install
node "%DEVCONTROL_LOCAL_ENTRY%" %*
exit /b %ERRORLEVEL%

:devcontrol_local_install
set "DEVCONTROL_ENTRY=%DEVCONTROL_WRAPPER_ROOT%\\node_modules\\${PACKAGE}\\build\\devcontrol.js"
if not exist "%DEVCONTROL_ENTRY%" set "DEVCONTROL_ENTRY=%DEVCONTROL_WRAPPER_ROOT%\\node_modules\\${PACKAGE}\\bin\\devcontrol.js"
if not exist "%DEVCONTROL_ENTRY%" goto :devcontrol_npx
node "%DEVCONTROL_ENTRY%" %*
exit /b %ERRORLEVEL%

:devcontrol_npx
call npx.cmd --yes --cache "%DEVCONTROL_NPX_CACHE%" "${spec}" %*
exit /b %ERRORLEVEL%
`;
}

function ps1Body() {
  return `# ${MARK}: ${VERSION}
# Project-local version-locked entry point. Details: .devcontrol/bin/devcontrol
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$DevcontrolArguments
)

$WrapperRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path
$CacheRoot = if ($env:DEVCONTROL_NPX_CACHE) {
  $env:DEVCONTROL_NPX_CACHE
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "devcontrol\\npm-cache"
} else {
  Join-Path $WrapperRoot ".devcontrol\\npm-cache"
}

if ($env:DEVCONTROL_LOCAL_ENTRY) {
  & node $env:DEVCONTROL_LOCAL_ENTRY @DevcontrolArguments
  exit $LASTEXITCODE
}

foreach ($Entry in @(
  (Join-Path $WrapperRoot "node_modules\\${PACKAGE}\\build\\devcontrol.js"),
  (Join-Path $WrapperRoot "node_modules\\${PACKAGE}\\bin\\devcontrol.js")
)) {
  if (Test-Path $Entry) {
    & node $Entry @DevcontrolArguments
    exit $LASTEXITCODE
  }
}

& npx.cmd --yes --cache $CacheRoot "${spec}" @DevcontrolArguments
exit $LASTEXITCODE
`;
}

const BODIES = { devcontrol: shBody, "devcontrol.cmd": cmdBody, "devcontrol.ps1": ps1Body };

/**
 * 落盘入口壳。**幂等**：内容没变就不动（避免每次 init 都造出一条假改动）。
 *
 * @returns {{dir: string, files: string[], changed: string[]}}
 */
export function writeWrappers(root) {
  const dir = path.join(root, WRAPPER_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const changed = [];
  for (const name of WRAPPER_FILES) {
    const abs = path.join(dir, name);
    const body = BODIES[name]();
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (current !== body) {
      // 统一 LF：cmd 能读 LF，但 CRLF 进 sh 壳会让 shebang 带 \r 而失效
      fs.writeFileSync(abs, body, "utf8");
      changed.push(name);
    }
    // 可执行位只在 POSIX 上存在；Windows 靠扩展名分派，chmod 是空操作，不必费心
    if (process.platform !== "win32") fs.chmodSync(abs, 0o755);
  }
  return { dir: WRAPPER_DIR, files: [...WRAPPER_FILES], changed };
}

/** 当前应写入的版本标记，给体检/测试断言用 */
export const wrapperVersion = VERSION;