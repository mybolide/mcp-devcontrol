// devcontrol — 周报渲染层：排版对不对，看字符串就行
import test from "node:test";
import assert from "node:assert/strict";
import { renderWeekly } from "../src/weekly-md.js";
import { weekly } from "../src/weekly.js";
import { makeRepo, initFlow } from "./helpers.js";

const sample = {
  since: "2026-03-03T12:00:00.000Z",
  until: "2026-03-10T12:00:00.000Z",
  days: 7,
  totals: { created: 1, claimed: 2, closed: 2, blocked: 1, overridden: 1, reworks: 1, tasks: 2, lines: 42 },
  byDay: [
    { day: "2026-03-05", created: 1, claimed: 1, closed: 0, blocked: 1, overridden: 0 },
    { day: "2026-03-06", created: 0, claimed: 0, closed: 2, blocked: 0, overridden: 0 },
  ],
  byActor: [
    { actor: "agent-a", closed: 1, claimed: 1, blocked: 1 },
    { actor: "agent-b", closed: 1, claimed: 1, blocked: 0 },
  ],
  topBlocked: [{ code: "E_SCOPE_VIOLATION", count: 2 }],
};

test("renderWeekly：标题带起止日期，紧跟一句结论", () => {
  const md = renderWeekly(sample);
  const lines = md.split("\n");
  assert.equal(lines[0], "# 周报 2026-03-03 ~ 2026-03-10");
  assert.equal(lines[1], "");
  assert.match(lines[2], /收口 2 条/);
  assert.match(lines[2], /成率 100%/);
});

test("renderWeekly：三节都在，数字原样落到表里", () => {
  const md = renderWeekly(sample);
  assert.match(md, /## 每天/);
  assert.match(md, /## 按人/);
  assert.match(md, /## 主要拦在哪/);
  assert.match(md, /^\| 日期 \| 新建 \| 领取 \| 收口 \| 被拦 \| 放行 \|$/m);
  assert.match(md, /^\| 2026-03-05 \| 1 \| 1 \| 0 \| 1 \| 0 \|$/m);
  assert.match(md, /^\| 2026-03-06 \| 0 \| 0 \| 2 \| 0 \| 0 \|$/m);
  assert.match(md, /^\| agent-a \| 1 \| 1 \| 1 \|$/m);
  assert.match(md, /^- `E_SCOPE_VIOLATION` × 2$/m);
});

test("renderWeekly：表格每行列数一致（markdown 不会错行）", () => {
  const md = renderWeekly(sample);
  for (const block of md.split("\n\n")) {
    const rows = block.split("\n").filter((l) => l.startsWith("|"));
    if (!rows.length) continue;
    const cols = rows[0].split("|").length;
    for (const r of rows) assert.equal(r.split("|").length, cols, `列数不一致：${r}`);
  }
});

test("renderWeekly：空周只说一句话，不留空表头", () => {
  const md = renderWeekly({
    since: "2026-03-03T12:00:00.000Z",
    until: "2026-03-10T12:00:00.000Z",
    days: 7,
    totals: { created: 0, claimed: 0, closed: 0, blocked: 0, overridden: 0, reworks: 0, tasks: 0, lines: 0 },
    byDay: [],
    byActor: [],
    topBlocked: [],
  });
  assert.match(md, /这一周没有动工记录/);
  assert.match(md, /_这周一条事件都没有_/);
  assert.match(md, /_这周没人领活_/);
  assert.doesNotMatch(md, /\| --- \|/, "空周不该冒出空表");
  assert.doesNotMatch(md, /## 主要拦在哪/, "没拦截就别摆一节空标题");
});

test("renderWeekly：没有被拦时不出现「主要拦在哪」", () => {
  const md = renderWeekly({ ...sample, topBlocked: [] });
  assert.doesNotMatch(md, /## 主要拦在哪/);
  assert.match(md, /## 按人/);
});

test("renderWeekly：不进「被拦」的两类也摊开，读者不会以为这周干干净净", () => {
  const md = renderWeekly({ ...sample, totals: { ...sample.totals, envOnly: 3, faults: 2 } });
  assert.match(md, /## 不进「被拦」的那些/);
  assert.match(md, /补一步就好（用法\/环境类）：3 次/);
  assert.match(md, /内核自身故障：2 次/, `内核的 bug 也要写出来：${md}`);
  assert.match(md, /不算 Agent 的账/, "还得说清归属");
});

test("renderWeekly：两类都是 0 时不摆这一节", () => {
  const md = renderWeekly({ ...sample, totals: { ...sample.totals, envOnly: 0, faults: 0 } });
  assert.doesNotMatch(md, /## 不进「被拦」的那些/, "没有就别摆空标题");
});

test("renderWeekly：自定义标题；结尾正好一个换行", () => {
  const md = renderWeekly(sample, { title: "研发周报" });
  assert.match(md, /^# 研发周报 2026-03-03 ~ 2026-03-10$/m);
  assert.ok(md.endsWith("\n"));
  assert.ok(!md.endsWith("\n\n"));
});

test("两层接口对得上：weekly() 的输出直接喂给 renderWeekly()", () => {
  const root = makeRepo();
  const { db } = initFlow(root);
  const stmt = db.prepare(
    "INSERT INTO events(at, actor, channel, action, task_id, code, detail) VALUES(?,?,?,?,?,?,?)",
  );
  stmt.run("2026-03-05T10:00:00.000Z", "agent-a", "agent", "task.claim", "T-001", null, "");
  // 用真会被拦的码：close.fail + E_NO_EVIDENCE 属于「补一步就好」，
  // 统一口径后不再算被拦（T-118），拿它当样本等于在测旧账。
  stmt.run("2026-03-05T11:00:00.000Z", "agent-a", "agent", "close.fail", "T-001", "E_SCOPE_VIOLATION", "第 1 次");
  stmt.run("2026-03-06T11:00:00.000Z", "agent-a", "agent", "close", "T-001", null, "");

  const md = renderWeekly(weekly(db, { days: 7, now: new Date("2026-03-10T12:00:00.000Z") }));
  assert.match(md, /# 周报 2026-03-03 ~ 2026-03-10/);
  assert.match(md, /收口 1 条（领了 1，成率 100%）/);
  assert.match(md, /`E_SCOPE_VIOLATION` × 1/);
  assert.match(md, /^\| agent-a \| 1 \| 1 \| 1 \|$/m);
});