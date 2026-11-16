// devcontrol — flow 模板：把「一次交付怎么拆」沉淀下来复用
// 存放：<项目>/.devcontrol/flows/<name>.json（跟仓库走，进 git —— 它是团队的做法，不是机器状态）
// 只描述「需求验收 + 任务怎么拆」，不碰 Path 契约（验收命令仍然由 Owner 批准时冻结）
import fs from "node:fs";
import path from "node:path";
import { reqIntake } from "./store.js";
export const FLOWS_REL = ".devcontrol/flows";

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function flowsDir(root = process.cwd()) {
  return path.join(root, FLOWS_REL);
}

export function flowPath(name, root = process.cwd()) {
  if (!NAME_RE.test(String(name ?? ""))) {
    const err = new Error(`flow 名字只能用 a-z、0-9、连字符（2–41 字符）：${name}`);
    err.code = "INVALID_ARGUMENT";
    throw err;
  }
  return path.join(flowsDir(root), `${name}.json`);
}

/** 读一个模板（文件坏了要明确报错，不能静默返回空模板） */
export function readFlow(name, root = process.cwd()) {
  const file = flowPath(name, root);
  if (!fs.existsSync(file)) {
    const err = new Error(`没有这个 flow：${name}（先 devcontrol flow list）`);
    err.code = "NOT_FOUND";
    throw err;
  }
  let body;
  try {
    body = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    const err = new Error(`flow 文件不是合法 JSON：${FLOWS_REL}/${name}.json（${e.message}）`);
    err.code = "INVALID_ARGUMENT";
    throw err;
  }
  return normalize(body, name);
}

export function listFlows(root = process.cwd()) {
  const dir = flowsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
    .map((name) => {
      try {
        const f = readFlow(name, root);
        return { name, description: f.description, acceptance: f.acceptance.length, tasks: f.tasks.length };
      } catch (e) {
        return { name, error: e.message };
      }
    });
}

function normalize(body, name) {
  const acceptance = Array.isArray(body.acceptance) ? body.acceptance.map(String).filter(Boolean) : [];
  if (!acceptance.length) {
    const err = new Error(`flow ${name} 至少要有一条验收（acceptance）`);
    err.code = "INVALID_ARGUMENT";
    throw err;
  }
  const tasks = (Array.isArray(body.tasks) ? body.tasks : []).map((t, i) => ({
    title: String(t.title ?? `任务 ${i + 1}`),
    scope: Array.isArray(t.scope) ? t.scope.map(String) : undefined,
    deriveFrom: (Array.isArray(t.deriveFrom) ? t.deriveFrom : [0]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < acceptance.length),
    dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < i),
  }));
  return { name, description: String(body.description ?? ""), acceptance, tasks };
}

export function writeFlow(body, root = process.cwd()) {
  const flow = normalize(body, body.name);
  const file = flowPath(flow.name, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
  return { ...flow, file };
}

/**
 * 从一个已完成的需求沉淀模板：验收照抄，任务拆法（标题/scope/验收映射/依赖）照抄。
 * 依赖用「任务在模板里的下标」表示，换项目也能用。
 */
export function flowFromRequirement(db, reqId, name, root = process.cwd()) {
  const req = db.prepare("SELECT * FROM requirements WHERE id=?").get(reqId);
  if (!req) {
    const err = new Error(`需求不存在：${reqId}`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const acceptance = JSON.parse(req.acceptance_json ?? "[]");
  const rows = db.prepare("SELECT * FROM tasks WHERE requirement_id=? AND status<>'parked' ORDER BY id").all(reqId);
  const index = new Map(rows.map((t, i) => [t.id, i]));
  const tasks = rows.map((t) => {
    const acc = JSON.parse(t.acceptance_json ?? "[]");
    return {
      title: t.title,
      scope: JSON.parse(t.scope_json ?? "[]"),
      deriveFrom: [...new Set(acc.map((a) => Number(a.deriveFrom)).filter((n) => Number.isInteger(n)))],
      dependsOn: [...new Set(JSON.parse(t.depends_on_json ?? "[]").map((d) => index.get(d)).filter((n) => Number.isInteger(n)))],
    };
  });
  return writeFlow({ name, description: req.title, acceptance, tasks }, root);
}

/** 用模板建一条需求草稿（批准仍然只能由 Owner 在控制台做） */
export function flowToRequirement(db, root, name) {
  const flow = readFlow(name, root);
  const { id } = reqIntake(db, root, {
    type: "requirement",
    title: flow.description || `按 flow ${name} 交付`,
    goal: `按 flow 模板 ${name} 交付（${flow.tasks.length} 个任务）`,
    acceptance: flow.acceptance,
  });
  return { requirementId: id, flow };
}
