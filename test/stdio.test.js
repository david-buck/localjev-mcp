import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverPath = join(projectRoot, "src", "index.js");

async function startServer(t, extraEnv = {}) {
  const sandboxHome = await mkdtemp(join(tmpdir(), "localjev-stdio-home-"));
  const keyPath = join(sandboxHome, "missing-key");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: projectRoot,
    stderr: "pipe",
    env: {
      HOME: sandboxHome,
      TYPESAFE_KEY_FILE: keyPath,
      ...extraEnv,
    },
  });
  const client = new Client({ name: "localjev-stdio-test", version: "0.1.0" });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));

  t.after(async () => {
    await client.close().catch(() => {});
    await rm(sandboxHome, { recursive: true, force: true });
  });

  await client.connect(transport);
  return { client, stderr: () => stderr.join("") };
}

test("stdio MCP initializes and lists the Jev tools", async (t) => {
  const { client } = await startServer(t);
  const { tools } = await client.listTools();

  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    ["jev_check", "jev_classify", "jev_doctor", "jev_evaluate", "jev_models", "jev_score"],
  );
  assert.equal(client.getServerVersion()?.name, "localjev");
  assert.equal(client.getServerVersion()?.version, "0.1.0");
  assert.ok(tools.every((tool) => tool.inputSchema.type === "object"));
});

test("missing credentials return an MCP error without leaking secrets", async (t) => {
  const { client, stderr } = await startServer(t);
  const result = await client.callTool({
    name: "jev_check",
    arguments: {
      state: "non-sensitive test state",
      instructions: "Is this a test?",
    },
  });

  assert.equal(result.isError, true);
  const output = JSON.stringify(result);
  assert.match(output, /No TypeSafe API key is available/);
  assert.doesNotMatch(output, /Bearer/);
  assert.doesNotMatch(output, /test-secret/);
  assert.doesNotMatch(stderr(), /test-secret/);
});

test("mocked provider failures return a safe MCP error without exposing the response body or key", async (t) => {
  const mockDir = await mkdtemp(join(tmpdir(), "localjev-stdio-mock-"));
  const mockPath = join(mockDir, "mock-fetch.mjs");
  const leakedSecret = "test-secret-stdio-key";
  await writeFile(
    mockPath,
    `globalThis.fetch = async () => new Response(JSON.stringify({ error: "provider body ${leakedSecret}" }), { status: 503 });\n`,
    "utf8",
  );
  t.after(() => rm(mockDir, { recursive: true, force: true }));

  const { client, stderr } = await startServer(t, {
    TYPESAFE_API_KEY: leakedSecret,
    NODE_OPTIONS: `--import=${pathToFileURL(mockPath).href}`,
  });
  const result = await client.callTool({
    name: "jev_score",
    arguments: {
      state: "test state",
      instructions: "How test-like is this state?",
      criteria: ["Not test-like", "Test-like"],
    },
  });

  assert.equal(result.isError, true);
  const output = JSON.stringify(result);
  assert.match(output, /TypeSafe API request failed \(HTTP 503\)/);
  assert.doesNotMatch(output, new RegExp(leakedSecret));
  assert.doesNotMatch(output, /provider body/);
  assert.doesNotMatch(stderr(), new RegExp(leakedSecret));
});

test("malformed successful provider JSON is reduced to a safe MCP error", async (t) => {
  const mockDir = await mkdtemp(join(tmpdir(), "localjev-stdio-invalid-json-"));
  const mockPath = join(mockDir, "mock-fetch.mjs");
  const leakedBody = "PRIVATE_PROVIDER_BODY";
  await writeFile(
    mockPath,
    `globalThis.fetch = async () => new Response("${leakedBody} not json", { status: 200 });\n`,
    "utf8",
  );
  t.after(() => rm(mockDir, { recursive: true, force: true }));

  const { client, stderr } = await startServer(t, {
    TYPESAFE_API_KEY: "test-secret-stdio-key",
    NODE_OPTIONS: `--import=${pathToFileURL(mockPath).href}`,
  });
  const result = await client.callTool({
    name: "jev_check",
    arguments: { state: "test state", instructions: "Is this a test?" },
  });

  assert.equal(result.isError, true);
  const output = JSON.stringify(result);
  assert.match(output, /TypeSafe API returned invalid JSON/);
  assert.doesNotMatch(output, new RegExp(leakedBody));
  assert.doesNotMatch(stderr(), new RegExp(leakedBody));
});
