#!/usr/bin/env node
// devcontrol 入口（分发壳）。两条路：
//   ① 仓库/开发态：有 src/ 就跑源码——测试与调试必须跑的是源码，绝不能误跑一份过期的 build；
//   ② 装成包：files 里只带 build/，于是走单文件产物（依赖已经内联，不需要 node_modules 解析）。
// MCP 配置、控制台自启、项目内入口壳（.devcontrol/bin/）都指向这个文件，所以它必须一直存在。
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const srcEntry = fileURLToPath(new URL("../src/cli.js", import.meta.url));

if (fs.existsSync(srcEntry)) {
  const { main } = await import("../src/cli.js");
  const code = await main(process.argv.slice(2));
  // 用 exitCode 而不是 process.exit()：后者会丢掉还没刷进管道的 stdout（export / run 的大输出会被截断）
  process.exitCode = typeof code === "number" ? code : 0;
} else {
  // 产物自己会执行 main 并设置退出码
  await import(new URL("../build/devcontrol.js", import.meta.url).href);
}