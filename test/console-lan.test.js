// devcontrol — 局域网访问：能跨机器打开，但绝不是一个谁都能点「批准」的页面
//
// 背景：Owner 有两台电脑，控制台必须能在另一台上打开。
// 但那页面上每个按钮都是 Owner 的权力（批准需求冻契约、放行门禁、调预算、发布打 tag），
// 而且它没有登录。所以「绑到局域网」这件事必须同时满足两条：
//   ① 只认回环和 --host 指定的地址（挡 DNS rebinding）
//   ② 非回环绑定强制令牌（挡同网段任何人）
// 少任何一条，这个功能就不该发布。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import { makeRepo, initFlow, BIN } from "./helpers.js";

const PORT_BASE = 24000 + Math.floor(Math.random() * 8000);

/** 起一个控制台，返回 { port, token, stop } */
function startConsole(root, { host = "127.0.0.1", port = PORT_BASE } = {}) {
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port), "--host", host], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`serve 未就绪：${out}`)), 15000);
    const done = () => {
      clearTimeout(timer);
      const token = out.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1] ?? null;
      resolve({ port, token, out, stop: () => child.kill() });
    };
    const onData = (d) => {
      out += d.toString();
      if (out.includes("项目：")) done();
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
 * 必须用 node:http，不能用 fetch：undici 把 Host 当「禁止修改的头」丢掉，
 * 于是「陌生 Host 该被拒」这条测试永远测到的是 127.0.0.1 —— 绿的但没在测。
 */
const fetchAs = (port, path, hostHeader, token) =>
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
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            text: () => body,
            json: () => JSON.parse(body || "{}"),
          }),
        );
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

test("默认（回环）绑定不需要令牌，行为不变", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root, { port: PORT_BASE + 1 });
  try {
    assert.equal(svc.token, null, "回环绑定不该生成令牌");
    const r = await fetchAs(svc.port, "/api/state");
    assert.equal(r.status, 200, "本机访问照旧不要令牌");
  } finally {
    svc.stop();
  }
});

test("绑到局域网必须生成令牌，并把带令牌的链接打印出来", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root, { host: "0.0.0.0", port: PORT_BASE + 2 });
  try {
    assert.ok(svc.token, "非回环绑定必须生成令牌");
    assert.ok(svc.token.length >= 20, "令牌要够长");
    assert.match(svc.out, /\?token=/, "启动日志要给出可直接打开的链接");
    assert.match(svc.out, /别外传/, "要明确这是 Owner 身份的钥匙");
  } finally {
    svc.stop();
  }
});

test("局域网绑定：没令牌 403，错令牌 403，对令牌 200", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root, { host: "0.0.0.0", port: PORT_BASE + 3 });
  const ip = lanIp();
  const hostHeader = ip ? `${ip}:${svc.port}` : null;
  try {
    const none = await fetchAs(svc.port, "/api/state", hostHeader);
    assert.equal(none.status, 403, "无令牌必须被拒");
    assert.match((await none.json()).message, /令牌/);

    const wrong = await fetchAs(svc.port, "/api/state", hostHeader, "not-the-token");
    assert.equal(wrong.status, 403, "错令牌必须被拒");

    const good = await fetchAs(svc.port, "/api/state", hostHeader, svc.token);
    assert.equal(good.status, 200, "对令牌要能读状态");
    const body = await good.json();
    assert.ok(Array.isArray(body.tasks), "拿到的应该是真的状态");
  } finally {
    svc.stop();
  }
});

test("首页 HTML 不需要令牌（否则浏览器连登录框都加载不出来）", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root, { host: "0.0.0.0", port: PORT_BASE + 4 });
  try {
    const r = await fetchAs(svc.port, "/");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /devcontrol 控制台/);
  } finally {
    svc.stop();
  }
});

test("陌生 Host 一律 403（挡 DNS rebinding），哪怕令牌对", async () => {
  const root = makeRepo();
  initFlow(root);
  const svc = await startConsole(root, { host: "0.0.0.0", port: PORT_BASE + 5 });
  try {
    const r = await fetchAs(svc.port, "/api/state", "evil.example.com:" + svc.port, svc.token);
    assert.equal(r.status, 403, "陌生 Host 必须被拒");
    assert.match((await r.json()).message, /Host 不被信任/);
  } finally {
    svc.stop();
  }
});

test("令牌也能从环境变量给（多机复用时不想每次换链接）", async () => {
  const root = makeRepo();
  initFlow(root);
  const port = PORT_BASE + 6;
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port), "--host", "0.0.0.0"], {
    cwd: root,
    env: { ...process.env, DEVCONTROL_ROOT: root, DEVCONTROL_OWNER_TOKEN: "my-fixed-token-123456" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve 未就绪：${out}`)), 15000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes("项目：")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
  try {
    await ready;
    assert.doesNotMatch(out, /\?token=[A-Za-z0-9_-]{20,}/, "自己给了令牌就不该再生成一个打印出来");
    const ok = await fetchAs(port, "/api/state", null, "my-fixed-token-123456");
    assert.equal(ok.status, 200, "环境变量里的令牌应生效");
    const no = await fetchAs(port, "/api/state");
    assert.equal(no.status, 403, "没带令牌仍要被拒");
  } finally {
    child.kill();
  }
});