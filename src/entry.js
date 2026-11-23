// devcontrol — 打包入口
//
// 为什么要单独一个文件：`bin/devcontrol.js` 是分发壳（仓库里优先跑源码、装成包后跑 build 产物），
// 它自己不能当打捆入口——否则产物里会带上一段「再去找 build 产物」的分支，自己指向自己。
// 这里只做源码版 bin 干的那一件事：把 argv 交给 main，把返回码变成退出码。
import { main } from "./cli.js";

const code = await main(process.argv.slice(2));
// 用 exitCode 而不是 process.exit()：后者会丢掉还没刷进管道的 stdout（export / run 的大输出会被截断）
process.exitCode = typeof code === "number" ? code : 0;