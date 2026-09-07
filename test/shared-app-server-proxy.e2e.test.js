import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createProxyServer } from "../scripts/shared-app-server-proxy.js";

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data, isBinary) => resolve({ data, isBinary }));
    ws.once("error", reject);
  });
}

function closeWebSocketServer(wss) {
  return new Promise((resolve) => wss.close(resolve));
}

test("proxies large and consecutive websocket text messages without transport loss", async (t) => {
  const backendMessages = [];
  const backend = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    backend.once("listening", resolve);
    backend.once("error", reject);
  });

  backend.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      backendMessages.push({ text: data.toString("utf8"), isBinary });
      ws.send(data, { binary: isBinary });
    });
  });

  const backendPort = backend.address().port;
  const proxy = createProxyServer({
    listenUrl: "ws://127.0.0.1:0",
    backendUrl: `ws://127.0.0.1:${backendPort}`,
    logger: () => {},
  });
  await proxy.start();

  const proxyPort = proxy.server.address().port;
  const client = new WebSocket(`ws://127.0.0.1:${proxyPort}`, { perMessageDeflate: false });
  await waitForOpen(client);
  t.after(async () => {
    client.terminate();
    await proxy.close();
    await closeWebSocketServer(backend);
  });

  const large = JSON.stringify({
    method: "turn/start",
    params: { payload: "x".repeat(80 * 1024) },
  });
  const firstReply = waitForMessage(client);
  client.send(large);
  assert.equal((await firstReply).data.toString("utf8"), large);

  for (const seq of [1, 2, 3]) {
    const text = JSON.stringify({
      method: "ping",
      params: { seq, payload: "y".repeat(24 * 1024) },
    });
    const reply = waitForMessage(client);
    client.send(text);
    assert.equal((await reply).data.toString("utf8"), text);
  }

  const malformed = JSON.stringify({
    method: "thread/start",
    params: {
      config: {
        mcp_servers: {
          codex_app: { enabled: true, enabled_tools: ["browser"] },
          keep_me: { command: "node", args: ["server.js"] },
        },
      },
    },
  });
  const cleanedReply = waitForMessage(client);
  client.send(malformed);
  const cleaned = JSON.parse((await cleanedReply).data.toString("utf8"));
  assert.equal(cleaned.params.config.mcp_servers.codex_app, undefined);
  assert.deepEqual(cleaned.params.config.mcp_servers.keep_me, {
    command: "node",
    args: ["server.js"],
  });

  assert.equal(client.readyState, WebSocket.OPEN);
  assert.equal(backendMessages.length, 5);
  assert.equal(backendMessages[0].text, large);
  assert.equal(backendMessages.every((message) => message.isBinary === false), true);
  assert.equal(
    JSON.parse(backendMessages[4].text).params.config.mcp_servers.codex_app,
    undefined,
  );
});
