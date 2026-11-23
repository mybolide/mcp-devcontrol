// devcontrol — 打包构建：把内核 + 依赖压成一个自包含文件
//
// 为什么要打包（而不是直接发 src + runtime deps）：
//   1. 装完就能跑：`npx mcp-devcontrol` 现在要先解析 @modelcontextprotocol/sdk 和 zod，
//      SDK 一换代（v1 → v2 拆包）老版本就在用户机器上装不起来；
//   2. 供应链面小：发布物里只有我们自己的代码，没有传递依赖的传递依赖；
//   3. 启动快：不用逐层读 node_modules。
//
// 产物：
//   build/devcontrol.js   单文件（依赖全内联，node: 内置模块保持 external）
//   build/index.html      控制台页面（从 public/index.html 复制：浏览器要整份响应体）
//
// 为什么要 banner 里的 createRequire 垫片：产物里一旦有 CJS 依赖（或有人在 ESM 里
// 调 require），esbuild 生成的是会抛 "Dynamic require is not supported" 的桩。
// 显式给一个真的 require，产物才不会在某个冷路径上炸。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "build");

fs.rmSync(OUT, { recursive: true, force: true });

const result = await build({
  entryPoints: [path.join(REPO, "src", "entry.js")],
  outfile: path.join(OUT, "devcontrol.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  // ESM 而不是 CJS：源码里有顶层 await（main 是异步的），压成 CJS 直接编不过
  format: "esm",
  // node: 内置模块（fs / path / node:sqlite …）不进产物；其余全部内联
  packages: "bundle",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  banner: {
    js: [
      "#!/usr/bin/env node",
      "// devcontrol 打包产物 —— 由 scripts/bundle.mjs 生成，不要手改。",
      "// 源码：https://github.com/mybolide/mcp-devcontrol",
      "import { createRequire as __dcCreateRequire } from 'node:module';",
      "const require = __dcCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  metafile: true,
});

// 控制台页面跟着一起发，否则控制台起来了是个 404
fs.copyFileSync(path.join(REPO, "public", "index.html"), path.join(OUT, "index.html"));

const kb = (p) => `${(fs.statSync(p).size / 1024).toFixed(1)} KB`;
const builtins = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imp of output.imports) {
    // external 且带 node: 前缀 = 内置模块，没进产物（这正是要确认的）
    if (imp.external && imp.path.startsWith("node:")) builtins.add(imp.path);
  }
}
console.log("构建完成：");
console.log(`  build/devcontrol.js  ${kb(path.join(OUT, "devcontrol.js"))}`);
console.log(`  build/index.html     ${kb(path.join(OUT, "index.html"))}`);
console.log(`  external（node 内置）：${[...builtins].sort().join(" ")}`);