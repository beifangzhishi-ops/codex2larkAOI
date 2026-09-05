import assert from "node:assert/strict";
import test from "node:test";
import { rewriteClientJsonText } from "../scripts/shared-app-server-proxy.js";

function rewrite(payload) {
  return rewriteClientJsonText(JSON.stringify(payload));
}

test("removes nested policy-only codex_app config", () => {
  const result = rewrite({
    jsonrpc: "2.0",
    id: 1,
    method: "thread/start",
    params: {
      config: {
        mcp_servers: {
          codex_app: { enabled: true, enabled_tools: ["browser"] },
          user_server: { command: "node", args: ["server.js"] },
        },
      },
    },
  });

  assert.equal(result.changed, true);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.params.config.mcp_servers.codex_app, undefined);
  assert.deepEqual(parsed.params.config.mcp_servers.user_server, {
    command: "node",
    args: ["server.js"],
  });
});

test("removes dotted policy-only codex_app table", () => {
  const result = rewrite({
    method: "thread/resume",
    params: { config: { "mcp_servers.codex_app": { enabled_tools: ["browser"] } } },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(result.text).params.config, {});
});

test("removes flattened codex_app policy keys when no transport exists", () => {
  const result = rewrite({
    method: "thread/start",
    params: {
      config: {
        "mcp_servers.codex_app.enabled": true,
        "mcp_servers.codex_app.enabled_tools": ["browser"],
        "mcp_servers.other.enabled": true,
      },
    },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(result.text).params.config, { "mcp_servers.other.enabled": true });
});

test("preserves complete command transport", () => {
  const original = {
    method: "thread/start",
    params: {
      config: {
        mcp_servers: {
          codex_app: { command: "cmd.exe", args: ["/c", "server.mjs"], enabled_tools: ["browser"] },
        },
      },
    },
  };
  const result = rewrite(original);
  assert.equal(result.changed, false);
  assert.equal(result.text, JSON.stringify(original));
});

test("preserves complete url transport", () => {
  const original = {
    method: "thread/resume",
    params: { configOverrides: { "mcp_servers.codex_app": { url: "http://127.0.0.1:9999/mcp", enabled: true } } },
  };
  assert.equal(rewrite(original).changed, false);
});

test("does not touch unrelated payload objects", () => {
  const original = {
    method: "turn/start",
    params: { input: { mcp_servers: { codex_app: { enabled_tools: ["literal-user-data"] } } } },
  };
  assert.equal(rewrite(original).changed, false);
});

test("leaves invalid JSON untouched", () => {
  const text = "not-json";
  assert.deepEqual(rewriteClientJsonText(text), { text, changed: false, removals: 0, method: null });
});
