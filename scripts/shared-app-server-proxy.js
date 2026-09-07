import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const DEFAULT_LISTEN = "ws://127.0.0.1:45789";
const DEFAULT_BACKEND = "ws://127.0.0.1:45790";
const POLICY_KEYS = new Set(["enabled", "enabled_tools", "disabled_tools"]);
const CONFIG_KEYS = ["config", "configOverrides"];
const WS_HEADER_NAMES = new Set([
  "host", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version",
  "sec-websocket-extensions", "sec-websocket-protocol",
]);

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
function requestProtocols(req) {
  const value = req.headers["sec-websocket-protocol"];
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function forwardedHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (WS_HEADER_NAMES.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = value;
  }
  return result;
}

function rawDataToText(data) {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function relayClose(target, code, reason) {
  if (target.readyState === WebSocket.CONNECTING) return void target.terminate();
  if (target.readyState !== WebSocket.OPEN) return;
  if ([1004, 1005, 1006, 1015].includes(code) || code < 1000 || code > 4999) return void target.terminate();
  target.close(code, reason);
}
function bindWebSockets(clientWs, backendWs, logger) {
  clientWs.on("message", (data, isBinary) => {
    if (backendWs.readyState !== WebSocket.OPEN) return;
    if (isBinary) return void backendWs.send(data, { binary: true });
    const result = rewriteClientJsonText(rawDataToText(data));
    if (result.changed) {
      logger?.(`[shared-proxy] stripped malformed codex_app overlay method=${result.method ?? "unknown"} removals=${result.removals}`);
    }
    backendWs.send(result.text, { binary: false });
  });
  backendWs.on("message", (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
  });
  clientWs.on("close", (code, reason) => relayClose(backendWs, code, reason));
  backendWs.on("close", (code, reason) => relayClose(clientWs, code, reason));
  clientWs.on("error", (error) => {
    logger?.(`[shared-proxy] client error: ${error.message}`);
    backendWs.terminate();
  });
  backendWs.on("error", (error) => {
    logger?.(`[shared-proxy] backend error: ${error.message}`);
    clientWs.terminate();
  });
}

function proxyHttp(req, res, backend) {
  const headers = { ...req.headers, host: backend.host };
  delete headers["sec-websocket-extensions"];
  const up = http.request({
    hostname: backend.hostname,
    port: Number(backend.port),
    path: req.url,
    method: req.method,
    headers,
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  up.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(`backend unavailable: ${error.message}\n`);
  });
  req.pipe(up);
}

function openBackendWebSocket(req, backend) {
  const target = new URL(req.url || "/", backend);
  const protocols = requestProtocols(req);
  const options = { perMessageDeflate: false, headers: forwardedHeaders(req.headers) };
  return protocols.length ? new WebSocket(target, protocols, options) : new WebSocket(target, options);
}
function proxyUpgrade(req, client, head, backend, wss, logger) {
  client.pause();
  const backendWs = openBackendWebSocket(req, backend);
  let upgraded = false;
  const fail = (error) => {
    logger?.(`[shared-proxy] backend handshake error: ${error.message}`);
    if (!client.destroyed) client.destroy();
    if (backendWs.readyState !== WebSocket.CLOSED) backendWs.terminate();
  };
  const abortPending = () => {
    if (!upgraded && backendWs.readyState !== WebSocket.CLOSED) backendWs.terminate();
  };
  client.once("close", abortPending);
  backendWs.once("error", fail);
  backendWs.once("open", () => {
    backendWs.off("error", fail);
    if (client.destroyed) return void backendWs.terminate();
    req.sharedBackendProtocol = backendWs.protocol || "";
    try {
      wss.handleUpgrade(req, client, head, (clientWs) => {
        upgraded = true;
        client.off("close", abortPending);
        bindWebSockets(clientWs, backendWs, logger);
        client.resume();
      });
    } catch (error) {
      fail(error);
    }
  });
}
export function createProxyServer({
  listenUrl = DEFAULT_LISTEN,
  backendUrl = DEFAULT_BACKEND,
  logger = console.log,
} = {}) {
  const listen = new URL(listenUrl);
  const backend = new URL(backendUrl);
  for (const url of [listen, backend]) {
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("proxy only accepts local ws:// URLs");
    }
  }
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols(protocols, request) {
      const selected = request.sharedBackendProtocol;
      return selected && protocols.has(selected) ? selected : false;
    },
  });
  const server = http.createServer((req, res) => proxyHttp(req, res, backend));
  server.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, backend, wss, logger));

  const start = () => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(listen.port), listen.hostname, resolve);
  });
  const close = () => new Promise((resolve) => {
    for (const socket of wss.clients) socket.terminate();
    const finishServer = () => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    };
    if (wss.clients.size === 0) return finishServer();
    wss.close(finishServer);
  });

  return { server, wss, start, close };
}

function args(argv) {
  let listenUrl = DEFAULT_LISTEN;
  let backendUrl = DEFAULT_BACKEND;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--listen") listenUrl = argv[++i];
    else if (argv[i] === "--backend") backendUrl = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { listenUrl, backendUrl };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const options = args(process.argv.slice(2));
  const proxy = createProxyServer(options);
  proxy.start()
    .then(() => console.log(`[shared-proxy] ${options.listenUrl} -> ${options.backendUrl}`))
    .catch((error) => {
      console.error(error.stack ?? error);
      process.exit(1);
    });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await proxy.close();
      process.exit(0);
    });
  }
}
