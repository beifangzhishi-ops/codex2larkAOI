import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LISTEN = "ws://127.0.0.1:45789";
const DEFAULT_BACKEND = "ws://127.0.0.1:45790";
const POLICY_KEYS = new Set(["enabled", "enabled_tools", "disabled_tools"]);
const CONFIG_KEYS = ["config", "configOverrides"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
const hasTransport = (v) => isObj(v) && (nonEmpty(v.command) || nonEmpty(v.url));
const policyOnly = (v) => isObj(v) && Object.keys(v).some((k) => POLICY_KEYS.has(k)) && !hasTransport(v);

function sanitize(config) {
  if (!isObj(config)) return 0;
  let removed = 0;
  if (isObj(config.mcp_servers) && policyOnly(config.mcp_servers.codex_app)) {
    delete config.mcp_servers.codex_app;
    removed += 1;
  }
  if (policyOnly(config["mcp_servers.codex_app"])) {
    delete config["mcp_servers.codex_app"];
    removed += 1;
  }
  const prefix = "mcp_servers.codex_app.";
  const keys = Object.keys(config).filter((k) => k.startsWith(prefix));
  if (keys.length) {
    const hasPolicy = keys.some((k) => POLICY_KEYS.has(k.slice(prefix.length)));
    const hasFlatTransport = nonEmpty(config[`${prefix}command`]) || nonEmpty(config[`${prefix}url`]);
    if (hasPolicy && !hasFlatTransport) {
      for (const key of keys) delete config[key];
      removed += keys.length;
    }
  }
  return removed;
}

export function rewriteClientJsonText(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return { text, changed: false, removals: 0, method: null }; }
  if (!isObj(msg) || !isObj(msg.params)) return { text, changed: false, removals: 0, method: msg?.method ?? null };
  let removals = 0;
  for (const key of CONFIG_KEYS) if (isObj(msg.params[key])) removals += sanitize(msg.params[key]);
  return removals
    ? { text: JSON.stringify(msg), changed: true, removals, method: msg.method ?? null }
    : { text, changed: false, removals: 0, method: msg.method ?? null };
}

function unmask(payload, mask) {
  if (!mask) return payload;
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ mask[i & 3];
  return out;
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const ext = payload.length < 126 ? 0 : payload.length <= 0xffff ? 2 : 8;
  const head = Buffer.alloc(2 + ext + 4);
  head[0] = 0x81;
  head[1] = 0x80 | (ext === 0 ? payload.length : ext === 2 ? 126 : 127);
  if (ext === 2) head.writeUInt16BE(payload.length, 2);
  if (ext === 8) head.writeBigUInt64BE(BigInt(payload.length), 2);
  mask.copy(head, 2 + ext);
  const body = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, body]);
}

class FrameFilter {
  constructor(target, logger) {
    this.target = target;
    this.logger = logger;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
  }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      const frame = this.next();
      if (!frame) return;
      this.handle(frame);
    }
  }
  next() {
    if (this.buf.length < 2) return null;
    const a = this.buf[0], b = this.buf[1];
    const fin = !!(a & 0x80), rsv = a & 0x70, opcode = a & 0x0f, masked = !!(b & 0x80);
    let len = b & 0x7f, off = 2;
    if (len === 126) { if (this.buf.length < 4) return null; len = this.buf.readUInt16BE(2); off = 4; }
    if (len === 127) { if (this.buf.length < 10) return null; const n = this.buf.readBigUInt64BE(2); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame too large"); len = Number(n); off = 10; }
    let mask = null;
    if (masked) { if (this.buf.length < off + 4) return null; mask = this.buf.subarray(off, off + 4); off += 4; }
    if (this.buf.length < off + len) return null;
    const raw = this.buf.subarray(0, off + len);
    const payload = unmask(this.buf.subarray(off, off + len), mask);
    this.buf = this.buf.subarray(off + len);
    return { fin, rsv, opcode, raw, payload };
  }
  handle(f) {
    if (f.opcode >= 8 || f.rsv) return void this.target.write(f.raw);
    if (f.opcode === 1 && f.fin) return void this.writeText(f.payload);
    if (f.opcode === 1 && !f.fin) { this.fragments = [f.payload]; return; }
    if (f.opcode === 0 && this.fragments) {
      this.fragments.push(f.payload);
      if (f.fin) { const payload = Buffer.concat(this.fragments); this.fragments = null; this.writeText(payload); }
      return;
    }
    this.target.write(f.raw);
  }
  writeText(payload) {
    const result = rewriteClientJsonText(payload.toString("utf8"));
    if (result.changed) this.logger?.(`[shared-proxy] stripped malformed codex_app overlay method=${result.method ?? "unknown"} removals=${result.removals}`);
    this.target.write(result.changed ? maskedTextFrame(result.text) : maskedTextFrame(payload.toString("utf8")));
  }
}

function stripExtensions(header) {
  return Buffer.from(header.toString("latin1").split("\r\n").filter((l) => !l.toLowerCase().startsWith("sec-websocket-extensions:")).join("\r\n"), "latin1");
}

function upgradeRequest(req, backend) {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (const [name, value] of Object.entries(req.headers)) {
    if (["host", "sec-websocket-extensions"].includes(name.toLowerCase())) continue;
    if (Array.isArray(value)) for (const v of value) lines.push(`${name}: ${v}`);
    else if (value !== undefined) lines.push(`${name}: ${value}`);
  }
  lines.push(`host: ${backend.host}`, "", "");
  return lines.join("\r\n");
}

function proxyHttp(req, res, backend) {
  const headers = { ...req.headers, host: backend.host };
  delete headers["sec-websocket-extensions"];
  const up = http.request({ hostname: backend.hostname, port: Number(backend.port), path: req.url, method: req.method, headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end(`backend unavailable: ${e.message}\n`); });
  req.pipe(up);
}

function proxyUpgrade(req, client, head, backend, logger) {
  client.pause();
  const up = net.createConnection({ host: backend.hostname, port: Number(backend.port) });
  let handshake = Buffer.alloc(0);
  up.once("connect", () => up.write(upgradeRequest(req, backend)));
  const onHandshake = (chunk) => {
    handshake = handshake.length ? Buffer.concat([handshake, chunk]) : Buffer.from(chunk);
    const end = handshake.indexOf("\r\n\r\n");
    if (end < 0) { if (handshake.length > 65536) { client.destroy(); up.destroy(); } return; }
    up.off("data", onHandshake);
    const headerEnd = end + 4;
    const header = handshake.subarray(0, headerEnd);
    const rest = handshake.subarray(headerEnd);
    client.write(stripExtensions(header));
    if (!header.toString("latin1").match(/^HTTP\/1\.[01] 101\b/)) { if (rest.length) client.write(rest); up.pipe(client); return client.resume(); }
    if (rest.length) client.write(rest);
    const filter = new FrameFilter(up, logger);
    if (head.length) filter.feed(head);
    client.on("data", (d) => { try { filter.feed(d); } catch (e) { logger?.(`[shared-proxy] frame error: ${e.message}`); client.destroy(); up.destroy(); } });
    up.on("data", (d) => client.write(d));
    client.resume();
  };
  up.on("data", onHandshake);
  up.on("error", (e) => { logger?.(`[shared-proxy] backend error: ${e.message}`); client.destroy(); });
  up.on("close", () => client.end());
  client.on("error", () => up.destroy());
  client.on("close", () => up.destroy());
}

export function createProxyServer({ listenUrl = DEFAULT_LISTEN, backendUrl = DEFAULT_BACKEND, logger = console.log } = {}) {
  const listen = new URL(listenUrl), backend = new URL(backendUrl);
  for (const u of [listen, backend]) if (u.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("proxy only accepts local ws:// URLs");
  const server = http.createServer((req, res) => proxyHttp(req, res, backend));
  server.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, backend, logger));
  return { server, start: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(listen.port), listen.hostname, resolve); }), close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function args(argv) {
  let listenUrl = DEFAULT_LISTEN, backendUrl = DEFAULT_BACKEND;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--listen") listenUrl = argv[++i];
    else if (argv[i] === "--backend") backendUrl = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { listenUrl, backendUrl };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const options = args(process.argv.slice(2));
  const proxy = createProxyServer(options);
  proxy.start().then(() => console.log(`[shared-proxy] ${options.listenUrl} -> ${options.backendUrl}`)).catch((e) => { console.error(e.stack ?? e); process.exit(1); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, async () => { await proxy.close(); process.exit(0); });
}
