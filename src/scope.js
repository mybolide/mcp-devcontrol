// devcontrol — scope 边界校验：任务 scope 只能落在仓库内的相对路径上。
//
// 为什么单独一个文件：两个入口都要用它，而它们分属 gates.js（Agent 建任务）
// 和 store.js（Owner 放宽 scope）。早先一处都没有，于是 `/tmp/x`、`../x`、
// `~/.zshrc` 都能写进任务 scope——等于内核批准 Agent 去改仓库外的任意文件，
// 而 git 看不见这些改动，既不进 diff、也进不了证据指纹（T-124）。
import path from "node:path";
import fs from "node:fs";
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

/**
 * 拒绝「等于没写 scope」的写法：`.` 和空串表示整个仓库。
 *
 * 为什么这是硬拦而不是提醒（T-130）：scope 写成 `.` 时，Agent 可以在仓库任何地方
 * 新建任意文件，内核一个字都拦不住——实测过：另写一套 `lib/calc/` + `helpers/` +
 * 自己的测试，4 个文件、3 层重复包装，close 一路通过，被拦 0、返工 0。
 * 那一版内核把「另起一套」当成「主观代码质量」放进了靠自觉那一栏，可它其实是
 * diff 里明摆着的事实：有 scope 才有归属，有归属才谈得上复用。
 *
 * 想覆盖整仓就写具体目录（`src,test`），或者按需列文件。
 */
export function assertScopeIsSpecific(scope) {
  if (!Array.isArray(scope)) return;
  const whole = scope.filter((raw) => {
    const s = String(raw).trim();
    return s === "." || s === "" || s === "./" || s === "/" || s === "**";
  });
  if (whole.length) {
    throw scopeError("scope 不能是整个仓库（. / 空 / **）", {
      data: { scope: whole },
      hint: "scope 是整个仓库等于没有 scope：Agent 可以在任何地方另起一套而内核拦不住。写具体目录或文件，比如 --scope src,gates.js",
    });
  }
}

/**
 * 把「整个仓库」的授权折成具体目录。
 *
 * Path 的 allowed_paths 写成 `.` 是合理的：Owner 批准的是「这个需求可以动整个仓库」，
 * 那是授权上限。但任务 scope 不能是上限——它说的是「这次到底动哪几片地」。
 * 早先两者共用一个值，于是 Agent 每次拿到的 scope 都是 `.`，等于没有约束（T-130）。
 *
 * 这里取仓库顶层的真实目录（跳过隐藏目录与内核自己的 .devcontrol/），
 * 得到 `src,test,public` 这种能直接写进 --scope 的东西。
 */
export function concreteTopDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith(".") && name !== "node_modules")
    .sort();
}

/**
 * 任务的默认 scope：Path 授权具体目录就照抄；授权整个仓库就折成顶层目录。
 * 折不出任何目录（空仓库）时返回空数组，由调用方报错——宁可让事情停下来，
 * 也不要给一个「什么都能改」的 scope。
 */
export function suggestScope(root, allowedPaths) {
  const list = Array.isArray(allowedPaths) ? allowedPaths.map(String) : [];
  const whole = list.some((s) => [".", "", "./", "/", "**"].includes(String(s).trim()));
  if (!whole) return list;
  const concrete = concreteTopDirs(root);
  return concrete.length ? concrete : [];
}
