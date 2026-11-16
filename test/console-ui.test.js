// devcontrol — 控制台交互：Owner 的动作必须走表单，不许回到 prompt()
//
// 为什么值得一条测试：prompt() 是回退按钮——它不能校验、不能给字段级提示、
// 不能二次确认，而且放行这种动作一旦手滑就进审计了。这里把约束钉住。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const HTML = path.join(import.meta.dirname, "..", "public", "index.html");
const src = fs.readFileSync(HTML, "utf8");
// 只取 <script> 里的代码，注释里提到 prompt 是在讲道理，不算违规
const script = src.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";

test("控制台不再用 prompt()/alert()/confirm()：这些都没有校验和字段提示", () => {
  const offenders = script
    .split("\n")
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /(^|[^.\w])(window\.)?(prompt|alert|confirm)\s*\(/.test(line));
  assert.deepEqual(
    offenders.map((o) => `${o.no}: ${o.line.trim()}`),
    [],
    "Owner 动作要走 openSheet / confirmSheet",
  );
});

test("表单弹层提供了字段、校验与计数", () => {
  for (const fn of ["function openSheet(", "function confirmSheet("]) {
    assert.ok(script.includes(fn), `缺少 ${fn}`);
  }
  // 校验能力：必填、字数下限、数值区间
  for (const probe of ["minLength", "aria-invalid", "不能小于", "至少 "]) {
    assert.ok(script.includes(probe), `弹层缺少校验能力：${probe}`);
  }
  // dialog + 遮罩，而不是自绘 div 弹窗（Esc / 焦点陷阱由浏览器负责）
  assert.match(src, /<dialog class="sheet"/);
  assert.match(src, /showModal\(\)/);
});

test("放行、打回、改预算三个动作都走表单，且放行带二次确认", () => {
  const override = script.slice(script.indexOf('if (b.dataset.override)'));
  const reopen = script.slice(script.indexOf('if (b.dataset.reopen)'), script.indexOf('if (b.dataset.override)'));
  const budget = script.slice(script.indexOf('if (b.dataset.budget)'), script.indexOf('if (b.dataset.memAccept)'));

  assert.ok(reopen.includes("openSheet("), "打回要用表单");
  assert.ok(budget.includes("openSheet("), "改预算要用表单");
  assert.ok(override.includes("openSheet("), "放行要用表单");
  // 整单放行不可逆（直接标 done），必须先过二次确认
  assert.ok(override.includes("confirmSheet("), "整单放行必须二次确认");
  assert.ok(override.includes('"force-close"'), "整单放行要真的传 force-close");
  // 理由门槛与内核一致：内核 12 字，前端不能更松
  assert.ok(/minLength:\s*12/.test(override), "放行理由字数下限要和内核同为 12");
});

test("改预算的弹层把当前值和已用量都摆出来，并说明放宽的生效范围", () => {
  const budget = script.slice(script.indexOf('if (b.dataset.budget)'), script.indexOf('if (b.dataset.memAccept)'));
  // 渲染侧把「已用多少」带进按钮，处理侧读出来显示：Owner 不看数字就没法判断该给多少
  assert.ok(script.includes("data-used="), "预算按钮要带上这条 Path 的已用量");
  assert.ok(budget.includes("dataset.used"), "改预算弹层要用到已用量");
  assert.ok(budget.includes("立即生效"), "要说明放宽对在办任务立即生效");
  assert.ok(budget.includes("只影响之后"), "要说明收紧只影响之后领取的任务");
});
