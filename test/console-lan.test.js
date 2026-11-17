// devcontrol — 局域网访问：默认直接可用，令牌是可选加固
//
// 两版之间的取舍值得写下来：
// 第一版为了「无登录的 Owner 面不能裸奔」，非回环绑定强制生成令牌，
// 结果每次打开都要复制一条二十多位的链接。Owner 的判断是：这是研发工作台，
// 摩擦大于收益，去掉。
// 所以现在的约定是：
//   · 绑局域网默认不校验令牌 —— 打一条地址就能在另一台电脑打开
//   · 想要加固的人设 DEVCONTROL_OWNER_TOKEN，设了才生效
//   · Host 白名单**始终**保留 —— 它零成本，挡的是 DNS rebinding
// 这组测试就是这三条。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import { makeRepo, initFlow, BIN } from "./helpers.js";

const PORT_BASE = 24000 + Math.floor(Math.random() * 8000);

/** 起一个控制台 */
function startConsole(root, { host = "127.0.0.1", port = PORT_BASE, env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port), "--host", host], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_OWNER_TOKEN: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`serve 未就绪：${out}`)), 15000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes("项目：")) {
        clearTimeout(timer);
        resolve({ port, out, stop: () => child.kill() });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve 退出 ${code}：${out}`));
    });
  });
}

/**
 * 用 node:http 而不是 fetch：undici 把 Host 当禁止修改的头丢掉，
 * 「陌生 Host 该被拒」那条会永远测到 127.0.0.1 —— 绿的但没在测。
 */
const get = (port, path, hostHeader, token) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: {
          host: hostHeader ?? `127.0.0.1:${port}`,
          ...(token ? { "x-owner-token": token } : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, text: () => body, json: () => JSON.parse(body || "{}") }));
      },
    );
    req.on("error", reject);
    req.end();
  });

const lanIp = () => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) if (info.family === "IPv4" && !info.internal) return info.address;
  }
  return null;
};

test("绑到局域网：直接给地址，不塞令牌，也不生成令牌", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root, { host: "0.0.0.0", port: PORT_BASE + 1 });
  try {
    assert.match(svc.out, /局域网（另一台电脑直接打开）/, "要明确给出可直接打开的地址");
    assert.doesNotMatch(svc.out, /\?token=/, "默认不该往地址里塞令牌");
    assert.match(svc.out, /同一局域网的人都能打开/, "要说清默认谁能连");
  } finally {
    svc.stop();
  }
});

test("局域网绑定默认不需要令牌：另一台电脑打开就能用", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root, { host: "0.0.0.0", port: PORT_BASE + 2 });
  const ip = lanIp();
  try {
    const r = await get(svc.port, "/api/state", ip ? `${ip}:${svc.port}` : null);
    assert.equal(r.status, 200, "不带令牌也要能读状态");
    assert.ok(Array.isArray(r.json().tasks));
  } finally {
    svc.stop();
  }
});

test("想要加固就设 DEVCONTROL_OWNER_TOKEN：设了才校验", async () => {
  const root = makeRepo();
  initFlow(root);
  const port = PORT_BASE + 3;
  const svc = await startConsole(root, {
    host: "0.0.0.0",
    port,
    env: { DEVCONTROL_OWNER_TOKEN: "my-fixed-token-123456" },
  });
  try {
    assert.match(svc.out, /已启用令牌/, "设了令牌要告诉人怎么带");
    const no = await get(port, "/api/state");
    assert.equal(no.status, 403, "设了令牌就必须带");
    assert.match(no.json().message, /令牌/);
    assert.ok(no.json().hint, "拒绝时要说清怎么带上令牌");

    const bad = await get(port, "/api/state", null, "wrong");
    assert.equal(bad.status, 403, "错令牌同样被拒");

    const ok = await get(port, "/api/state", null, "my-fixed-token-123456");
    assert.equal(ok.status, 200, "对令牌应放行");
  } finally {
    svc.stop();
  }
});

test("首页 HTML 始终不需要令牌（否则浏览器连页面都加载不出来）", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root, { host: "0.0.0.0", port: PORT_BASE + 4, env: { DEVCONTROL_OWNER_TOKEN: "t0ken" } });
  try {
    const r = await get(svc.port, "/");
    assert.equal(r.status, 200);
    assert.match(r.text(), /devcontrol 控制台/);
  } finally {
    svc.stop();
  }
});

test("陌生 Host 一律 403（挡 DNS rebinding）——这条始终保留", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root, { host: "0.0.0.0", port: PORT_BASE + 5 });
  try {
    const r = await get(svc.port, "/api/state", `evil.example.com:${svc.port}`);
    assert.equal(r.status, 403);
    assert.match(r.json().message, /Host 不被信任/);
  } finally {
    svc.stop();
  }
});

test("回环绑定的行为完全没变（本机照旧零配置）", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root, { port: PORT_BASE + 6 });
  try {
    assert.doesNotMatch(svc.out, /局域网/, "只听回环时不该提局域网");
    const r = await get(svc.port, "/api/state");
    assert.equal(r.status, 200);
  } finally {
    svc.stop();
  }
});