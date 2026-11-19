#!/usr/bin/env node
/**
 * Safe batch runner for lx_source.js.
 * Reads JSON payload from stdin:
 *   { "lx_source_path": "...", "attempts": [{ "source": "kw", "quality": "flac", "musicInfo": {...} }], "probe": true }
 *Eliminates JS string-interpolation injection and executes multi-source fallback in a single VM instance.
 */
const fs = require("fs");
const vm = require("vm");
const crypto = require("crypto");
const path = require("path");

async function probeStreamUrl(testUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(testUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Range: "bytes=0-1023"
      },
      signal: controller.signal
    });
    const ct = String(resp.headers.get("content-type") || "").toLowerCase();
    try {
      if (resp.body) await resp.body.cancel();
    } catch (_) {}
    return (resp.status === 200 || resp.status === 206) && !ct.includes("application/json") && !ct.includes("text/html");
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const rawInput = fs.readFileSync(0, "utf8");
  const payload = JSON.parse(rawInput || "{}");
  const lxSourcePath = payload.lx_source_path || path.join(__dirname, "lx_source.js");
  const attempts = Array.isArray(payload.attempts) ? payload.attempts : [];
  const shouldProbe = payload.probe !== false;

  const code = fs.readFileSync(lxSourcePath, "utf8");
  const handlers = [];
  const lx = {
    EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert" },
    env: "desktop",
    version: "2.0.0",
    utils: {
      buffer: { from: (...a) => Buffer.from(...a) },
      crypto: { md5: (s) => crypto.createHash("md5").update(s).digest("hex") }
    },
    request(url, opts, cb) {
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      const controller = new AbortController();
      const timeoutMs = Number(opts?.timeout) || 8000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      fetch(url, {
        method: opts?.method || "GET",
        headers: opts?.headers || {},
        body: opts?.body,
        signal: controller.signal
      })
        .then(async (r) => {
          const ct = r.headers.get("content-type") || "";
          const body = ct.includes("json") ? await r.json().catch(() => r.text()) : await r.text();
          cb(null, { statusCode: r.status, body, headers: Object.fromEntries(r.headers.entries()) }, body);
        })
        .catch((err) => cb(err))
        .finally(() => clearTimeout(timer));
    },
    on(name, fn) {
      if (name === "request") handlers.push(fn);
    },
    send() {}
  };

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    URL,
    module: { exports: {} },
    exports: {},
    lx,
    globalThis: {},
    global: {}
  };
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis.lx = lx;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const sourceHandler = handlers[0];
  if (!sourceHandler) {
    process.stdout.write(JSON.stringify({ error: "no_handler" }) + "\n");
    return;
  }

  const errors = [];
  for (const item of attempts) {
    const src = String(item?.source || "");
    const quality = String(item?.quality || "flac");
    const musicInfo = item?.musicInfo && typeof item.musicInfo === "object" ? item.musicInfo : {};
    try {
      const ret = await sourceHandler({
        action: "musicUrl",
        source: src,
        info: { type: quality, musicInfo }
      });
      const resolvedUrl = typeof ret === "string" ? ret : ret?.url;
      if (resolvedUrl && /^https?:\/\//i.test(resolvedUrl)) {
        if (!shouldProbe || (await probeStreamUrl(resolvedUrl))) {
          process.stdout.write(JSON.stringify({ url: resolvedUrl, source: src, quality }) + "\n");
          return;
        }
        errors.push(`${src}/${quality}:probe_failed`);
      }
    } catch (e) {
      errors.push(`${src}/${quality}:${e?.message || "err"}`);
    }
  }

  process.stdout.write(JSON.stringify({ error: errors.join("; ") || "no_url" }) + "\n");
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err?.message || String(err) }) + "\n");
  process.exit(1);
});
