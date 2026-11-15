// devcontrol — 项目设置：需要人配的东西集中放这一处（.devcontrol/settings.json，不进 git）
// 优先级：环境变量 > settings.json > 内置默认。控制台「设置」页改的就是这个文件。
import fs from "node:fs";
import path from "node:path";

export const SETTINGS_REL = ".devcontrol/settings.json";

export const DEFAULTS = {
  memory: {
    enabled: true,
    provider: "ollama", // ollama | openai
    embeddingUrl: "", // 空 = 按 provider 推默认（ollama:11434 / openai:8000）
    model: "",
    apiKey: "",
    qdrantUrl: "http://127.0.0.1:6333",
    collection: "", // 空 = 按项目路径自动生成
  },
  console: {
    port: 7373,
    restartGraceMs: 10000,
  },
};

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function merge(base, patch) {
  if (!isObj(patch)) return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isObj(value) && isObj(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

/** 空字符串视同没配：回落到默认，否则界面上看起来像没配好 */
const pick = (envValue, fileValue, fallback) => {
  if (String(envValue ?? "").trim()) return String(envValue).trim();
  if (String(fileValue ?? "").trim()) return String(fileValue).trim();
  return fallback;
};

export function settingsFile(root = process.cwd()) {
  return path.join(path.resolve(root), SETTINGS_REL);
}

/** 读项目设置（文件不存在或坏掉就用默认，不影响任何命令跑起来） */
export function readSettings(root = process.cwd()) {
  try {
    return merge(DEFAULTS, JSON.parse(fs.readFileSync(settingsFile(root), "utf8")));
  } catch {
    return merge(DEFAULTS, {});
  }
}

/** 合并写回：只改传入的字段，其余保持原样 */
export function writeSettings(root, patch) {
  const next = merge(readSettings(root), patch);
  const file = settingsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** 当前实际生效的值（环境变量覆盖文件），设置页用来展示「现在到底在用哪个」 */
export function effectiveSettings(root = process.cwd(), env = process.env) {
  const s = readSettings(root);
  const provider = String(env.MEMORY_EMBEDDING_PROVIDER ?? s.memory.provider ?? "ollama").toLowerCase();
  const isOpenAI = provider === "openai" || provider === "openai-compatible";
  return {
    memory: {
      enabled: String(env.DEVCONTROL_MEMORY ?? (s.memory.enabled ? "on" : "off")).toLowerCase() !== "off",
      provider: isOpenAI ? "openai" : "ollama",
      embeddingUrl: pick(env.MEMORY_EMBEDDING_URL, s.memory.embeddingUrl, isOpenAI ? "http://127.0.0.1:8000/v1" : "http://127.0.0.1:11434"),
      model: pick(env.MEMORY_EMBEDDING_MODEL, s.memory.model, isOpenAI ? "text-embedding-3-small" : "nomic-embed-text"),
      apiKey: env.MEMORY_EMBEDDING_API_KEY ?? s.memory.apiKey ?? "",
      qdrantUrl: pick(env.MEMORY_QDRANT_URL, s.memory.qdrantUrl, "http://127.0.0.1:6333"),
      collection: pick(env.MEMORY_QDRANT_COLLECTION, s.memory.collection, ""),
      dbFile: env.DEVCONTROL_MEMORY_DB ?? path.join(path.resolve(root), ".devcontrol", "memory.db"),
    },
    console: {
      port: Number(env.DEVCONTROL_PORT ?? s.console.port ?? 7373),
      restartGraceMs: Number(env.DEVCONTROL_RESTART_GRACE_MS ?? s.console.restartGraceMs ?? 10000),
    },
  };
}
