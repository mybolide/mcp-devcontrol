// devcontrol — scope 边界校验：任务 scope 只能落在仓库内的相对路径上。
//
// 为什么单独一个文件：两个入口都要用它，而它们分属 gates.js（Agent 建任务）
// 和 store.js（Owner 放宽 scope）。早先一处都没有，于是 `/tmp/x`、`../x`、
// `~/.zshrc` 都能写进任务 scope——等于内核批准 Agent 去改仓库外的任意文件，
// 而 git 看不见这些改动，既不进 diff、也进不了证据指纹（T-124）。
import path from "node:path";

/** 统一的领域错误：带 code / hint / data，与内核其它错误同构。 */
function scopeError(message, extra = {}) {
  const err = new Error(message);
  err.code = "E_CONTRACT";
  Object.assign(err, extra);
  return err;
}

/**
 * 校验一组 scope 路径全部落在仓库内。
 * 不合规就 throw（调用方在 tx 里，会整笔回滚）。
 */
export function assertScopeInsideRepo(scope) {
  if (!Array.isArray(scope)) return;
  for (const raw of scope) {
    const s = String(raw);

    // 绝对路径：/tmp/x、C:\x、\\server\share
    if (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\")) {
      throw scopeError(`scope 必须是仓库内的相对路径：${s}`, {
        data: { scope: s },
        hint: "写相对仓库根的路径，比如 src/gates.js；绝对路径等于让内核批准你改本机任意文件",
      });
    }

    // `~` 由 shell 展开，内核不该替它猜
    if (s === "~" || s.startsWith("~/")) {
      throw scopeError(`scope 不能用 ~ 开头：${s}`, {
        data: { scope: s },
        hint: "换成仓库内的相对路径",
      });
    }

    // 归一化后仍带 .. 的，说明真的往上跳出了仓库根
    const normalized = path.posix.normalize(s.replace(/\\/g, "/"));
    if (normalized === ".." || normalized.startsWith("../")) {
      throw scopeError(`scope 不能跳出仓库根：${s}`, {
        data: { scope: s },
        hint: "去掉 ..；仓库外的东西不该出现在任务的 scope 里",
      });
    }
  }
}
