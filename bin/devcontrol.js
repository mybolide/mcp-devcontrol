#!/usr/bin/env node
import { main } from "../src/cli.js";

const code = await main(process.argv.slice(2));
// 用 exitCode 而不是 process.exit()：后者会丢掉还没刷进管道的 stdout（export / run 的大输出会被截断）
process.exitCode = typeof code === "number" ? code : 0;
