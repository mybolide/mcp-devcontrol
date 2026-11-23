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

test("收件箱只靠点击审批：对话授权输入框已经删掉", () => {
  // 早先这里有个「对话授权」面板：输入「批准 FR-002 使用 P-001」再看一遍再确认。
  // 点击本来就更快，而多一条「把自然语言变成授权」的路径，就多一处要防伪造的地方——
  // 所以面板、脚本、/api/chat/preview 预览口一起删了。这条测试钉住「真的删干净了」。
  for (const id of ["owner-chat-text", "owner-chat-send", "owner-chat-log"]) {
    assert.equal(src.includes(`id="${id}"`), false, `${id} 还在页面上：对话授权应当已经删掉`);
  }
  assert.equal(script.includes("ownerChat"), false, "对话授权的脚本没清干净");
  assert.equal(script.includes("/api/chat/preview"), false, "预览接口应随面板一起删");
  // 点击路径必须还在：收件箱的批准按钮走既有 Owner action，复用 Path 仍有二次确认
  assert.match(script, /owner\("approve"/, "点击审批不能跟着一起删掉");
  assert.match(script, /复用并批准/, "复用已批准 Path 前的确认还在");
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

test("需求收件箱允许复用已批准的 Path，并对重新绑定二次确认", () => {
  const inbox = script.slice(script.indexOf("function renderInbox("), script.indexOf("function renderTasks("));
  assert.ok(inbox.includes('.filter((p) => !p.requirement_id || p.status === "approved")'), "草稿需求必须能看到未绑定 Path 和已批准 Path");
  assert.ok(inbox.includes('data-rebind="${rebind ? "true" : "false"}"'), "复用操作必须显式标记重新绑定");
  assert.ok(inbox.includes("批准后将重新绑定到"), "界面必须说明 Path 会重新绑定到新需求");
  assert.ok(inbox.includes("冻结命令："), "批准前仍要展示将冻结的验收命令");

  const approve = script.slice(script.indexOf("if (b.dataset.approve)"), script.indexOf("if (b.dataset.abandon)"));
  assert.ok(approve.includes('b.dataset.rebind === "true"'), "只有复用 Path 才触发额外确认");
  assert.ok(approve.includes("confirmSheet("), "重新绑定必须二次确认");
  assert.ok(approve.indexOf("confirmSheet(") < approve.indexOf('owner("approve"'), "确认之前不能提交审批动作");
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

test("移动端：侧栏收成顶栏 + 抽屉菜单，正文不再被一屏菜单挤到下面", () => {
  // 手机上（≤900px）侧栏必须让位：品牌和菜单按钮排成一条顶栏，十项导航收进抽屉。
  // 早先是 static 的整块侧栏：390 宽的手机上它占 680px，正文从 y=680 才开始——
  // 打开手机第一屏看不到任何内容，得先滚过一整屏菜单。
  assert.match(src, /id="nav-toggle"/, "顶栏缺菜单按钮");
  assert.match(src, /aria-controls="side-panel"/, "菜单按钮要声明它控制哪块");
  assert.match(src, /class="sidepanel" id="side-panel"/, "导航要能整体收起");
  assert.match(src, /id="nav-scrim"/, "点空白处收起需要一个遮罩层");
  assert.match(script, /function setNav\(/, "抽屉要有开关逻辑");
  // 只切出 switchView 的函数体再断言：两段代码之间的距离随时会变，写死 500 字符会变成假失败
  const switchBody = script.slice(script.indexOf("function switchView("), script.indexOf("async function renderSettings("));
  assert.ok(switchBody.includes("setNav(false)"), "选完视图要自动收起抽屉");
  assert.match(script, /e\.key === "Escape"[\s\S]{0,120}?nav-open/, "Esc 要能收起抽屉");
  // 断点里必须真的把侧栏改成横排顶栏，而不是只把它堆到正文上面
  const media = src.slice(src.indexOf("@media (max-width: 900px)"));
  assert.match(media, /\.sidebar\s*\{[^}]*flex-direction:\s*row/, "手机顶栏要横排");
  assert.match(media, /\.sidebar\s*\{[^}]*position:\s*sticky/, "顶栏要常驻：滚到下面也能开菜单");
  assert.match(media, /body\.nav-open \.sidepanel \{ display: flex/, "抽屉展开的规则不见了");
  assert.match(media, /body\.nav-open \.navscrim/, "抽屉打开时要盖一层遮罩");
});

test("刷新后停在原来那一页：视图写进 hash 和 localStorage，启动时读回来", () => {
  // 单页应用里视图只活在内存里：刷新就回首页，人每次都得重新点一遍，等于没有导航。
  // 也真的踩过一次：仓库里已经有这段逻辑，但全局安装的控制台跑的还是旧页面——
  // 用户看到的「刷新回首页」其实是产物没更新。所以这里既钉逻辑，也提醒产物要同步。
  assert.match(script, /function initialView\(/, "缺 initialView：启动时不知道该停在哪一页");
  assert.match(script, /const VIEW_STORE = "devcontrol\.view"/, "要有一个固定的存储键");
  assert.match(script, /location\.hash[\s\S]{0,80}VIEW_KEYS\.includes/, "hash 优先：能收藏、能贴给别人");
  assert.match(script, /localStorage\.getItem\(VIEW_STORE\)/, "hash 没有时回落到上次停留的页");
  assert.match(script, /localStorage\.setItem\(VIEW_STORE, target\)/, "切页时要记住当前位置");
  assert.match(script, /history\.replaceState\(null, "", want\)/, "要写 hash，但不能往浏览历史里塞垃圾");
  assert.match(script, /switchView\(initialView\(\)\)/, "打开/刷新时必须按 hash 恢复视图");
  assert.match(script, /addEventListener\("hashchange"/, "改 hash 也要跟着切页");
});

test("收件箱要显示「已批准需求下新增的 draft Path」，让人能单独批 Path", () => {
  // 早先收件箱只看 draft 需求，这类 Path 永远不出现，人只能去命令行 discover。
  const inbox = script.slice(script.indexOf("function renderInbox"), script.indexOf("function completionCell"));
  assert.match(inbox, /x\.status === "draft"/, "要筛 draft Path");
  assert.match(inbox, /\["approved", "building"\]\.includes\(r\.status\)/, "只针对已批准/在办的需求");
  assert.match(inbox, /data-path-approve=/, "要有单独的批准按钮");
  assert.match(script, /dataset\.pathApprove\) return owner\("path\.approve"/, "按钮要调 Owner 的 path.approve");
});

test("需求页要列出这条需求的全部 Path，不能只取第一条", () => {
  // FR-004 曾一直显示已作废的 P-001，新的 P-003 看不见。
  const reqs = script.slice(script.indexOf("function renderReqs"), script.indexOf("function renderDocs"));
  assert.match(reqs, /s\.paths\.filter\(\(x\) => x\.requirement_id === r\.id\)/, "要按需求取全部 Path");
  assert.match(reqs, /related\.find\(\(x\) => x\.status === "approved"\)/, "优先展示仍然有效的 Path");
  assert.match(reqs, /\$\{allPaths\}/, "全部 Path 要渲染出来");
  assert.doesNotMatch(reqs, /s\.paths\.find\(\(x\) => x\.requirement_id === r\.id\)/, "不许再只取第一条");
});
