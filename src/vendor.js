// devcontrol — 依赖与构建产物：它们永远不是交付物
//
// 为什么内核要自己认这件事，而不是指望项目写对 .gitignore：
//   init 之后第一件事就是装依赖、跑构建。新项目往往还没有 .gitignore，
//   于是 `node_modules/` 会以未跟踪形态出现。此时——
//     · scope 写成 "."  → devcontrol commit 会把整个 node_modules 提交进仓库；
//     · scope 写成 "src" → 每个依赖文件都被当成「scope 外的改动」，commit 永久堵死。
//   两种结局都会毁掉仓库，而用户什么都没做错。
//
// 判定只对「未跟踪」生效：已经被 git 跟踪的 dist/ 是有人特意提交的，
// 内核不去翻案（那条路径照常参与 scope 与提交）。

/** 纯生成物目录名：出现在路径任意一段，就视为依赖/构建产物 */
export const VENDOR_DIRS = new Set([
  // JS / TS
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".vite",
  "coverage",
  ".nyc_output",
  // Python
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".eggs",
  "site-packages",
  // Rust / JVM / 其它
  "target",
  ".gradle",
  ".idea",
  // 通用缓存
  ".cache",
]);

/**
 * 名字太泛的目录：只在仓库根，或 monorepo 的包目录下才算。
 * `src/build/` 是源码，误判会让人白丢一次提交。
 */
const BUILD_DIR_NAMES = new Set(["dist", "build", "out"]);
const WORKSPACE_DIRS = new Set(["packages", "apps", "libs", "modules", "services"]);

const segs = (p) =>
  String(p ?? "")
    .split("\\")
    .join("/")
    .split("/")
    .filter(Boolean);

/**
 * 这条「目录」路径是不是依赖/构建产物？
 * `dist`/`build`/`out` 只在两种位置算：仓库根（`dist/`），或 monorepo 包目录下（`packages/web/dist`）。
 */
export function isVendorDir(rel) {
  const seg = segs(rel);
  if (!seg.length) return false;
  if (VENDOR_DIRS.has(seg[0])) return true;
  for (let i = 1; i < seg.length; i += 1) if (VENDOR_DIRS.has(seg[i])) return true;
  if (BUILD_DIR_NAMES.has(seg[0])) return true;
  if (seg.length === 3 && WORKSPACE_DIRS.has(seg[0]) && BUILD_DIR_NAMES.has(seg[2])) return true;
  return false;
}

/** 这条「文件」路径是不是依赖/构建产物？只看它所在的目录 */
export function isVendorPath(file) {
  const seg = segs(file);
  if (seg.length < 2) return false;
  return isVendorDir(seg.slice(0, -1).join("/"));
}

/** .gitignore 里建议补的条目（init 写一次；已经有的不重复写） */
export const VENDOR_IGNORES = [
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  "__pycache__/",
  ".venv/",
  "target/",
];