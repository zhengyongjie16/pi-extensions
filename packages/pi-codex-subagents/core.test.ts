import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";
import type { AgentInfo } from "./core.js";
import type { ExtensionAPI, ToolExecutionComponent, ToolRenderers } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";

// macOS os.tmpdir() can be too long for a Unix socket address; keep the POSIX root short.
const TEST_AGENT_DIR = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "ps-"));
const FAKE_RPC_SOURCE = path.join(import.meta.dir, "test", "fake-rpc-child.js");
// Windows cannot spawn a shebang script directly; keep the executable fixture isolated.
const FAKE_RPC_CHILD = process.platform === "win32" ? path.join(TEST_AGENT_DIR, "fake-rpc-child.exe") : FAKE_RPC_SOURCE;
if (process.platform === "win32") {
  const build = spawnSync(process.execPath, ["build", "--compile", FAKE_RPC_SOURCE, "--outfile", FAKE_RPC_CHILD], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(`Failed to compile the RPC test fixture: ${build.stderr}`);
}
const previousTempDir = process.env.PI_SUBAGENT_TEMP_DIR;
process.env.PI_SUBAGENT_TEMP_DIR = TEST_AGENT_DIR;
afterAll(() => {
  if (previousTempDir === undefined) delete process.env.PI_SUBAGENT_TEMP_DIR;
  else process.env.PI_SUBAGENT_TEMP_DIR = previousTempDir;
  fs.rmSync(TEST_AGENT_DIR, { recursive: true, force: true });
});

const codingAgent = await import("@earendil-works/pi-coding-agent");
mock.module("@earendil-works/pi-coding-agent", () => ({
  ...codingAgent,
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => TEST_AGENT_DIR,
}));

const {
  AgentManager,
  EventBroadcaster,
  RpcAssistantStreamState,
  RpcJsonlDecoder,
  consumeFirstMatchingMailboxEvent,
  formatAgentError,
  formatContextUsage,
  normalizeContextUsage,
  readInfoFile,
  getAgent,
  getAgentDefinitionsDescription,
  getRunsDir,
  getSocketPath,
  loadSubagentConfig,
  parentScopeKey,
  parseAgentDefinitionText,
  taskStorageKey,
} = await import("./core.js");
const { formatAgentSpecLines, SubagentPeekOverlay } = await import("./peek.js");
const nativeCodemodeRenderers: ToolRenderers = {};
await codingAgent.createCodemodeExtension()({
  registerTool(definition) {
    Object.assign(nativeCodemodeRenderers, {
      renderShell: definition.renderShell, renderCall: definition.renderCall, renderResult: definition.renderResult,
    });
  },
} as ExtensionAPI);


test("formats the resolved subagent model and thinking for the detail overlay", () => {
  expect(formatAgentSpecLines({ provider: "openai-codex", modelId: "gpt-5.5", thinking: "high" })).toEqual([
    "Model: openai-codex/gpt-5.5",
    "Thinking: high",
  ]);
});

describe("RPC streaming", () => {
  test("assembles delta-only messages and distinguishes tool calls from thinking", () => {
    const stream = new RpcAssistantStreamState();
    stream.start({
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "pending",
      timestamp: Date.now(),
    });

    stream.update({ type: "thinking_start", contentIndex: 0 });
    stream.update({ type: "thinking_delta", contentIndex: 0, delta: "checking" });
    expect(stream.status).toBe("thinking");
    expect(stream.message?.content[0]).toMatchObject({ type: "thinking", thinking: "checking" });

    stream.update({ type: "toolcall_start", contentIndex: 1 });
    stream.update({ type: "toolcall_delta", contentIndex: 1, delta: '{"path":"src' });
    stream.update({ type: "toolcall_delta", contentIndex: 1, delta: '/ui.rs"}' });
    expect(stream.status).toBe("calling");
    expect(stream.message?.content[0]).toMatchObject({ type: "thinking", thinking: "checking" });
    expect(stream.message?.content[1]).toMatchObject({ type: "toolCall", arguments: { path: "src/ui.rs" } });

    stream.update({
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/ui.rs" } },
    });
    expect(stream.message?.content[1]).toEqual({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/ui.rs" } });
  });
});

describe("RPC framing", () => {
  test("explains explicit quota error codes on every platform", () => {
    expect(formatAgentError(Object.assign(new Error("write failed"), { code: "EDQUOT" })))
      .toContain("Disk quota exceeded (EDQUOT).");
  });

  test.skipIf(os.constants.errno.EDQUOT === undefined)("explains quota errors that Node leaves unnamed", () => {
    const error = Object.assign(new Error(`Unknown system error -${os.constants.errno.EDQUOT}, write`), {
      errno: -os.constants.errno.EDQUOT,
    });
    expect(formatAgentError(error)).toContain("Disk quota exceeded (EDQUOT).");
  });

  test("splits only on LF and preserves Unicode line separators", () => {
    const decoder = new RpcJsonlDecoder();
    const payload = JSON.stringify({ text: "before\u2028after" });
    expect(decoder.push(Buffer.from(payload.slice(0, 7)))).toEqual([]);
    expect(decoder.push(Buffer.from(`${payload.slice(7)}\n`))).toEqual([payload]);
    expect(decoder.end()).toEqual([]);
  });
});

describe("session-scoped identities", () => {
  test("separates parent sessions and formerly colliding task names", () => {
    expect(parentScopeKey("parent-a")).not.toBe(parentScopeKey("parent-b"));
    expect(taskStorageKey("review/api")).not.toBe(taskStorageKey("review__api"));
  });
});

describe("agent templates", () => {
  test("parses optional routing and extension fields", () => {
    const definition = parseAgentDefinitionText(`---
name: reviewer
provider: openai-codex
model: gpt-5.6-sol
thinking: high
extensions: @scope/tools, ~/.pi/helper.ts
skills: web-investigate
---
Review the requested files.`, "fallback");
    expect(definition).toMatchObject({
      name: "reviewer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
      extensions: ["@scope/tools", "~/.pi/helper.ts"],
      skills: ["web-investigate"],
      prompt: "Review the requested files.",
    });
  });

  test("trims routing values and treats blank values as omitted", () => {
    expect(parseAgentDefinitionText(`---
provider: "  openai  "
model: '  accounts/team/model  '
---`, "trimmed")).toMatchObject({ provider: "openai", model: "accounts/team/model" });
    expect(parseAgentDefinitionText(`---
provider: "   "
model: '   '
---`, "blank")).toMatchObject({ provider: undefined, model: undefined });
  });

  test("describes full pairs and model-only routes without advertising provider-only routing", () => {
    const directory = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents");
    const templates = {
      "description-full": 'provider: " template-provider "\nmodel: " template-model "',
      "description-model-only": 'provider: "   "\nmodel: template-model\nthinking: medium',
      "description-provider-only": 'provider: template-provider\nmodel: "   "',
    };
    fs.mkdirSync(directory, { recursive: true });
    try {
      for (const [name, fields] of Object.entries(templates)) {
        fs.writeFileSync(path.join(directory, `${name}.md`), `---\nname: ${name}\n${fields}\n---\n`);
      }
      const description = getAgentDefinitionsDescription();
      expect(description).toContain("- `description-full` — model: template-provider/template-model");
      expect(description).toContain("- `description-model-only` — model: template-model (inherited provider) — thinking: medium");
      expect(description.split("\n").find((line) => line.startsWith("- `description-provider-only`")))
        .toBe("- `description-provider-only`");
    } finally {
      for (const name of Object.keys(templates)) fs.rmSync(path.join(directory, `${name}.md`), { force: true });
    }
  });
});

describe("run storage", () => {
  const packageDir = path.join(TEST_AGENT_DIR, "pi-codex-subagents");
  const configFile = path.join(packageDir, "config.json");
  const fixtureDir = path.join(TEST_AGENT_DIR, "retention-fixture");

  test("uses persistent package storage by default", () => {
    fs.rmSync(configFile, { force: true });
    expect(getRunsDir()).toBe(path.join(packageDir, "runs"));
  });

  test("loads the model response timeout from package configuration", () => {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ modelResponseTimeoutMs: 1234 }));
    expect(loadSubagentConfig().modelResponseTimeoutMs).toBe(1234);
    fs.rmSync(configFile, { force: true });
  });

  test("keeps legacy temporary runs discoverable", () => {
    fs.rmSync(configFile, { force: true });
    const parentSessionId = "legacy-parent";
    const id = "11111111-1111-4111-8111-111111111111";
    const legacyRoot = path.join(process.env.PI_SUBAGENT_TEMP_DIR!, "pi-codex-subagents", os.userInfo().username, "runs");
    const legacyScope = path.join(legacyRoot, parentScopeKey(parentSessionId));
    fs.mkdirSync(legacyScope, { recursive: true });
    fs.writeFileSync(path.join(legacyScope, `${id}.info.json`), JSON.stringify({
      id,
      taskName: "legacy",
      status: "closed",
      finalResponse: "legacy response",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    expect(getAgent("legacy", parentSessionId)).toMatchObject({ id, status: "completed", finalResponse: "legacy response" });
    fs.rmSync(legacyScope, { recursive: true, force: true });
  });

  test("keeps agent lists in creation order when activity changes", async () => {
    fs.rmSync(configFile, { force: true });
    const parentSessionId = "creation-order";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const now = Date.now();
    const agents = [
      { id: "11111111-1111-4111-8111-111111111111", taskName: "older", createdAt: now - 2000, lastActivity: now },
      { id: "22222222-2222-4222-8222-222222222222", taskName: "newer", createdAt: now - 1000, lastActivity: now - 1000 },
    ];
    fs.mkdirSync(scope, { recursive: true });
    for (const agent of agents) {
      fs.writeFileSync(path.join(scope, `${agent.id}.info.json`), JSON.stringify({
        ...agent,
        canonicalName: `/${agent.taskName}`,
        parentSessionId,
        status: "completed",
        updatedAt: agent.lastActivity,
      }));
    }

    const manager = new AgentManager();
    try {
      expect(manager.listAgents(undefined, parentSessionId).map((agent) => agent.agent_name)).toEqual(["/newer", "/older"]);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test("removes expired runs and outputs using configurable retention", () => {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 3 }));

    const now = Date.now();
    const oldTime = new Date(now - 4 * 24 * 60 * 60 * 1000);
    const scope = path.join(fixtureDir, "a".repeat(24));
    const unrelatedScope = path.join(fixtureDir, "unrelated");
    const outputs = path.join(fixtureDir, "_outputs");
    const expiredId = "11111111-1111-4111-8111-111111111111";
    const activeId = "22222222-2222-4222-8222-222222222222";
    const expiredInfo = path.join(scope, `${expiredId}.info.json`);
    const activeInfo = path.join(scope, `${activeId}.info.json`);
    const expiredOutput = path.join(outputs, `${oldTime.getTime()}-33333333-3333-4333-8333-333333333333.txt`);
    const activeMarker = path.join(process.env.PI_SUBAGENT_TEMP_DIR!, "pi-codex-subagents", os.userInfo().username, "sockets", `${activeId}.peek.json`);
    const unrelatedAgentFile = path.join(scope, `${expiredId}.notes`);
    const staleLock = path.join(scope, `.task-${"c".repeat(24)}.lock`);
    const liveOwnerLock = path.join(scope, `.task-${"d".repeat(24)}.lock`);

    try {
      fs.mkdirSync(scope, { recursive: true });
      fs.mkdirSync(unrelatedScope, { recursive: true });
      fs.mkdirSync(outputs, { recursive: true });
      fs.mkdirSync(path.dirname(activeMarker), { recursive: true });
      for (const [file, id] of [[expiredInfo, expiredId], [activeInfo, activeId]]) {
        fs.writeFileSync(file, JSON.stringify({
          id,
          createdAt: oldTime.getTime(),
          updatedAt: oldTime.getTime(),
          lastActivity: oldTime.getTime(),
        }));
        fs.utimesSync(file, oldTime, oldTime);
      }
      fs.writeFileSync(activeMarker, JSON.stringify({ pid: process.pid, startedAt: now, token: "test" }));
      fs.writeFileSync(unrelatedAgentFile, "keep");
      fs.writeFileSync(staleLock, "");
      fs.writeFileSync(liveOwnerLock, JSON.stringify({ pid: process.pid }));
      fs.utimesSync(staleLock, oldTime, oldTime);
      fs.utimesSync(liveOwnerLock, oldTime, oldTime);
      fs.writeFileSync(expiredOutput, "old");
      fs.utimesSync(expiredOutput, oldTime, oldTime);
      fs.writeFileSync(path.join(outputs, "unrelated.txt"), "keep");
      fs.writeFileSync(path.join(unrelatedScope, "unrelated.txt"), "keep");

      new AgentManager();
      expect(fs.existsSync(expiredInfo)).toBe(false);
      expect(fs.existsSync(activeInfo)).toBe(true);
      expect(fs.existsSync(unrelatedAgentFile)).toBe(true);
      expect(fs.existsSync(staleLock)).toBe(false);
      expect(fs.existsSync(liveOwnerLock)).toBe(true);
      expect(fs.existsSync(expiredOutput)).toBe(false);
      expect(fs.existsSync(path.join(outputs, "unrelated.txt"))).toBe(true);
      expect(fs.existsSync(path.join(unrelatedScope, "unrelated.txt"))).toBe(true);

      fs.writeFileSync(configFile, JSON.stringify({ storageDir: fixtureDir, retentionDays: 0 }));
      fs.writeFileSync(expiredInfo, "{}");
      fs.utimesSync(expiredInfo, oldTime, oldTime);
      new AgentManager();
      expect(fs.existsSync(expiredInfo)).toBe(true);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(activeMarker, { force: true });
      fs.rmSync(configFile, { force: true });
    }
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readSocketEvents(socketPath: string, count: number): Promise<any[]> {
  return await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const events: any[] = [];
    let buffer = "";
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(events);
    };
    socket.setTimeout(1000, () => finish(new Error("Timed out waiting for subagent events.")));
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (events.length < count) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        events.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
      finish();
    });
  });
}

function spawnParams(parentSessionId: string, task_name: string, message: string) {
  return {
    task_name,
    message,
    cwd: TEST_AGENT_DIR,
    parentSessionId,
    inheritedProvider: "test",
    inheritedModelId: "fake",
  };
}

describe("spawn model and thinking resolution", () => {
  test("caller wins, then the template, then the inherited value, then the default", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "spawn-overrides";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    const templateFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents", "routed.md");
    fs.mkdirSync(path.dirname(templateFile), { recursive: true });
    fs.writeFileSync(templateFile, "---\nname: routed\nprovider: template-provider\nmodel: template-model\nthinking: medium\n---\nRouted template.");
    const modelOnlyFile = path.join(path.dirname(templateFile), "caller-priority.md");
    fs.writeFileSync(modelOnlyFile, "---\nname: caller-priority\nmodel: unregistered-template-model\n---\n");
    const manager = new AgentManager();
    const spawn = async (task: string, overrides: Record<string, unknown>) => {
      await manager.spawnAgent({ ...spawnParams(parentSessionId, task, "work"), inheritedThinking: "low", ...overrides });
      return manager.getAgentInfo(task, parentSessionId);
    };
    const callerModel = { model: { provider: "openai", modelId: "gpt-5" } };
    try {
      expect(await spawn("inherited", {})).toMatchObject({ model: "test:fake", thinking: "low" });
      expect(await spawn("caller-model", callerModel)).toMatchObject({ model: "openai:gpt-5", thinking: "low" });
      expect(await spawn("caller-thinking", { thinking: "max" })).toMatchObject({ model: "test:fake", thinking: "max" });
      expect(await spawn("template", { agent_type: "routed" })).toMatchObject({ model: "template-provider:template-model", thinking: "medium" });
      expect(await spawn("caller-beats-template", { agent_type: "routed", ...callerModel, thinking: "xhigh" })).toMatchObject({ model: "openai:gpt-5", thinking: "xhigh" });
      expect(await spawn("caller-beats-model-only", { agent_type: "caller-priority", ...callerModel })).toMatchObject({ model: "openai:gpt-5", thinking: "low" });
      // No level requested anywhere, not even by the parent, falls back to the package default.
      await manager.spawnAgent(spawnParams(parentSessionId, "default-thinking", "work"));
      expect(manager.getAgentInfo("default-thinking", parentSessionId)).toMatchObject({ model: "test:fake", thinking: "high" });
      await expect(spawn("missing", { agent_type: "absent" })).rejects.toThrow("Agent template not found");
    } finally {
      await manager.shutdown();
      fs.rmSync(templateFile, { force: true });
      fs.rmSync(modelOnlyFile, { force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test.each([
    ["model-only", "model: template-model", "test", "template-model"],
    ["blank-provider", 'provider: "   "\nmodel: template-model', "test", "template-model"],
    ["trimmed-pair", 'provider: " template-provider "\nmodel: " template-model "', "template-provider", "template-model"],
    ["provider-only", "provider: template-provider", "test", "fake"],
    ["blank-model", 'provider: template-provider\nmodel: "   "', "test", "fake"],
    ["empty-model", "provider: template-provider\nmodel:", "test", "fake"],
    ["blank-both", 'provider: "   "\nmodel: "   "', "test", "fake"],
  ])("resolves %s without changing inherited thinking", async (name, fields, provider, modelId) => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = `template-resolution-${name}`;
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const templateFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents", `${name}.md`);
    const manager = new AgentManager();
    fs.writeFileSync(templateFile, `---\nname: ${name}\n${fields}\n---\n`);
    try {
      await manager.spawnAgent({ ...spawnParams(parentSessionId, "worker", "hold routing"), agent_type: name, inheritedThinking: "xhigh" });
      expect(manager.getAgentInfo("worker", parentSessionId)).toMatchObject({
        provider, modelId, model: `${provider}:${modelId}`, thinking: "xhigh",
      });
    } finally {
      await manager.shutdown();
      fs.rmSync(templateFile, { force: true });
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });
});

describe("child model validation", () => {
  const invalidRoutes: Array<[string, string, string, Record<string, unknown>, string]> = [
    ["unknown-provider", "unknown-provider", "fake", {}, "not registered"],
    ["unknown-id", "test", "not-registered", {}, "not registered"],
    ["case-sensitive-id", "test", "Fake", {}, "not registered"],
    ["fuzzy-id", "openai", "gpt", { state: { model: { provider: "openai", id: "gpt-5" } } }, "not registered"],
    ["custom-unregistered", "openai", "custom/unregistered", {}, "not registered"],
    ["missing-catalog", "test", "fake", { availableModels: {} }, "not registered"],
    ["malformed-catalog", "test", "fake", { availableModels: { models: {} } }, "not registered"],
    ["empty-catalog", "test", "fake", { availableModels: { models: [] } }, "not registered"],
    ["crossed-pairs", "test", "fake", { availableModels: { models: [null, {}, { provider: "test", id: "other" }, { provider: "other", id: "fake" }] } }, "not registered"],
    ["no-selected-model", "test", "fake", { state: {} }, "get_state selected no model"],
    ["missing-state", "test", "fake", { state: null }, "get_state selected no model"],
    ["selected-provider-mismatch", "test", "fake", { state: { model: { provider: "other", id: "fake" } } }, 'get_state selected "other/fake"'],
    ["selected-id-mismatch", "test", "fake", { state: { model: { provider: "test", id: "template-model" } } }, 'get_state selected "test/template-model"'],
  ];

  test.each(invalidRoutes)("rejects %s before any prompt and cleans up the child", async (name, provider, modelId, responses, reason) => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES = JSON.stringify(responses);
    const parentSessionId = `invalid-route-${name}`;
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const templateFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents", `${name}.md`);
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    fs.writeFileSync(templateFile, `---\nname: ${name}\nprovider: ${provider}\nmodel: ${modelId}\n---\n`);
    try {
      const target = `${provider}/${modelId}`;
      await expect(manager.spawnAgent({ ...spawnParams(parentSessionId, "worker", "must not run"), agent_type: name }))
        .rejects.toThrow(target);
      const failed = manager.getAgentInfo("worker", parentSessionId);
      expect(failed).toMatchObject({ provider, modelId, status: "failed", messageCount: 0 });
      expect(failed.error).toContain(reason);
      expect(failed.finalResponse).toBeUndefined();
      expect(failed.childProcess).toBeUndefined();
      const records = fs.readFileSync(failed.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records.filter((entry) => entry.type === "prompt" || entry.type === "set_model")).toEqual([]);
      expect(records.some((entry) => entry.type === "get_available_models")).toBe(true);
      expect(pidAlive(records.find((entry) => entry.type === "started").pid)).toBe(false);
      if (process.platform !== "win32") expect(fs.existsSync(getSocketPath(failed.id))).toBe(false);
      const markerDirectory = path.join(process.env.PI_SUBAGENT_TEMP_DIR!, "pi-codex-subagents", os.userInfo().username, "sockets");
      expect(fs.existsSync(path.join(markerDirectory, `${failed.id}.active.json`))).toBe(false);
      expect(completions).toEqual([expect.objectContaining({ status: "failed", error: failed.error })]);
    } finally {
      await manager.shutdown();
      fs.rmSync(templateFile, { force: true });
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
      delete process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES;
    }
  });

  test("accepts an exact slash-containing template ID using read-only checks", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "exact-slash-route";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const templateFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents", "slash-route.md");
    const modelId = "accounts/fireworks/models/glm-5p2";
    const manager = new AgentManager();
    fs.writeFileSync(templateFile, `---\nname: slash-route\nmodel: ${modelId}\n---\n`);
    try {
      await manager.spawnAgent({
        ...spawnParams(parentSessionId, "worker", "hold exact route"),
        agent_type: "slash-route", inheritedProvider: "fireworks", inheritedModelId: "unused-parent-model",
      });
      const info = manager.getAgentInfo("worker", parentSessionId);
      expect(info).toMatchObject({ provider: "fireworks", modelId, model: `fireworks:${modelId}`, status: "running" });
      const records = fs.readFileSync(info.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records.filter((entry) => entry.type !== "get_session_stats").map((entry) => entry.type))
        .toEqual(["started", "get_state", "get_available_models", "prompt"]);
    } finally {
      await manager.shutdown();
      fs.rmSync(templateFile, { force: true });
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  const restartFailures: Array<[string, Record<string, unknown>, string]> = [
    ["catalog-drift", { availableModels: { models: [{ provider: "openai", id: "gpt-5" }] } }, "test/template-model"],
    ["selection-drift", { state: { model: { provider: "openai", id: "gpt-5" } } }, "test/template-model"],
    ["startup-exit", { exitOn: "get_state" }, "code=23"],
  ];
  test.each(restartFailures)("revalidates the persisted pair on restart after %s", async (name, responses, reason) => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = `restart-validation-${name}`;
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const templateFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents", `restart-${name}.md`);
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    fs.writeFileSync(templateFile, `---\nname: restart-${name}\nmodel: template-model\n---\n`);
    try {
      await manager.spawnAgent({ ...spawnParams(parentSessionId, "worker", "first"), agent_type: `restart-${name}` });
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "completed" && !info.childProcess;
      });
      // A template edit must not replace the saved pair at restart.
      fs.writeFileSync(templateFile, `---\nname: restart-${name}\nprovider: openai\nmodel: gpt-5\n---\n`);
      process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES = JSON.stringify(responses);
      await expect(manager.sendMessage(parentSessionId, "worker", "must not run")).rejects.toThrow(reason);
      const failed = manager.getAgentInfo("worker", parentSessionId);
      expect(failed).toMatchObject({ provider: "test", modelId: "template-model", model: "test:template-model", status: "failed", messageCount: 1 });
      expect(failed.error).toContain(reason);
      expect(failed.finalResponse).toBeUndefined();
      expect(failed.childProcess).toBeUndefined();
      const records = fs.readFileSync(failed.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const starts = records.filter((entry) => entry.type === "started");
      expect(starts).toHaveLength(2);
      for (const start of starts) {
        expect(start.args[start.args.indexOf("--provider") + 1]).toBe("test");
        expect(start.args[start.args.indexOf("--model") + 1]).toBe("template-model");
        expect(pidAlive(start.pid)).toBe(false);
      }
      expect(records.filter((entry) => entry.type === "prompt").map((entry) => entry.message)).toEqual(["first"]);
      expect(records.filter((entry) => entry.type === "get_state")).toHaveLength(2);
      if (name !== "startup-exit") expect(records.filter((entry) => entry.type === "get_available_models")).toHaveLength(2);
      expect((await manager.waitAgent(parentSessionId, ["worker"])).event).toMatchObject({ status: "failed", error: failed.error });
      expect(completions.filter((event) => event.status === "failed")).toHaveLength(1);
    } finally {
      await manager.shutdown();
      fs.rmSync(templateFile, { force: true });
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
      delete process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES;
    }
  });
});

describe("concurrent restarts", () => {
  test.each([
    ["hibernated", "invalid"],
    ["hibernated", "valid"],
    ["terminating", "invalid"],
    ["owned-cleanup", "invalid"],
  ] as const)("rejects a pending restart after %s (%s catalog)", async (phase, catalog) => {
    const validCatalog = catalog === "valid";
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = `concurrent-restart-${phase}-${validCatalog}`;
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    let releaseCleanup = () => {};
    let interruption: Promise<unknown> | undefined;
    try {
      const initialTask = phase === "terminating" ? "hold first" : "first";
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", initialTask));
      const initial = manager.getAgentInfo("worker", parentSessionId);
      let cleanupCalls = 0;
      if (phase === "terminating") {
        interruption = manager.interruptAgent(parentSessionId, "worker");
        await Promise.resolve();
        expect(manager["live"].get(initial.id)?.expectedExit).toBe(true);
      } else {
        await waitUntil(() => {
          const info = manager.getAgentInfo("worker", parentSessionId);
          return info.status === "completed" && !info.childProcess;
        });
        if (phase === "owned-cleanup") {
          // Force both callers across an async cleanup gap for stale persisted ownership.
          const info = manager.getAgentInfo("worker", parentSessionId);
          info.childProcess = initial.childProcess;
          fs.writeFileSync(info.infoFile, JSON.stringify(info));
          const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
          const terminate = manager["terminateOwnedChild"].bind(manager);
          manager["terminateOwnedChild"] = async (owned) => {
            cleanupCalls++;
            await cleanupGate;
            await terminate(owned);
          };
        }
      }
      if (!validCatalog) process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES = JSON.stringify({ availableModels: { models: [] } });
      const pending = Promise.allSettled([
        manager.sendMessage(parentSessionId, "worker", "hold first restart"),
        manager.sendMessage(parentSessionId, "worker", "hold second restart"),
      ]);
      await Promise.resolve();
      releaseCleanup();
      const attempts = await pending;
      await interruption;
      expect(attempts[1]).toMatchObject({
        status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("still starting") }),
      });
      if (validCatalog) expect(attempts[0]).toEqual({ status: "fulfilled", value: { delivery: "prompt" } });
      else expect(attempts[0]).toMatchObject({
        status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("not registered") }),
      });
      if (phase === "owned-cleanup") expect(cleanupCalls).toBe(2);
      const info = manager.getAgentInfo("worker", parentSessionId);
      expect(info).toMatchObject({ status: validCatalog ? "running" : "failed", messageCount: validCatalog ? 2 : 1 });
      expect(info.finalResponse).toBeUndefined();
      if (!validCatalog) expect(info.error).toContain("not registered");
      expect(completions.filter((event) => event.status === "failed")).toHaveLength(validCatalog ? 0 : 1);
      const records = fs.readFileSync(info.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const starts = records.filter((entry) => entry.type === "started");
      expect(starts).toHaveLength(2);
      if (!validCatalog) {
        expect(info.childProcess).toBeUndefined();
        for (const start of starts) expect(pidAlive(start.pid)).toBe(false);
      }
      expect(records.filter((entry) => entry.type === "prompt").map((entry) => entry.message))
        .toEqual(validCatalog ? [initialTask, "hold first restart"] : [initialTask]);
      const restart = records.slice(records.findLastIndex((entry) => entry.type === "started"));
      expect(restart.slice(0, 3).map((entry) => entry.type)).toEqual(["started", "get_state", "get_available_models"]);
      await manager.shutdown();
      expect(manager.getAgentInfo("worker", parentSessionId).childProcess).toBeUndefined();
      for (const start of starts) expect(pidAlive(start.pid)).toBe(false);
    } finally {
      releaseCleanup();
      await interruption;
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
      delete process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES;
    }
  });
});

describe("startup retry failure recording", () => {
  test.each(["failed", "interrupted"] as const)("records each new startup failure after a prior %s run", async (priorStatus) => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = `startup-retry-${priorStatus}`;
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      if (priorStatus === "failed") {
        process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES = JSON.stringify({ availableModels: { models: [] } });
        await expect(manager.spawnAgent(spawnParams(parentSessionId, "worker", "must not run"))).rejects.toThrow("not registered");
      } else {
        await manager.spawnAgent(spawnParams(parentSessionId, "worker", "hold old task"));
        await manager.interruptAgent(parentSessionId, "worker");
      }
      let previous = manager.getAgentInfo("worker", parentSessionId);
      expect(previous.status).toBe(priorStatus);
      let previousCompletionId = completions.at(-1)?.id;
      process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES = JSON.stringify({ exitOn: "get_state" });
      for (let attempt = 0; attempt < 2; attempt++) {
        const completionCount = completions.length;
        let returnedError: Error | undefined;
        try {
          await manager.sendMessage(parentSessionId, "worker", "must not run");
        } catch (error) {
          returnedError = error as Error;
        }
        expect(returnedError).toBeInstanceOf(Error);
        const message = returnedError!.message;
        expect(message).toContain("code=23");
        if (attempt === 0 && priorStatus === "failed") expect(previous.error).not.toBe(message);
        if (attempt === 1) expect(previous.error).toBe(message); // Identical causes are still distinct attempts.
        const failed = manager.getAgentInfo("worker", parentSessionId);
        expect(failed).toMatchObject({ status: "failed", error: message, messageCount: previous.messageCount });
        expect(failed.finalResponse).toBeUndefined();
        expect(failed.childProcess).toBeUndefined();
        expect(completions.slice(completionCount)).toEqual([expect.objectContaining({ status: "failed", error: message })]);
        const completion = completions[completionCount];
        expect(completion.id).not.toBe(previousCompletionId);
        expect((await manager.waitAgent(parentSessionId, ["worker"])).event).toMatchObject({ id: completion.id, status: "failed", error: message });
        const records = fs.readFileSync(failed.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        const starts = records.filter((entry) => entry.type === "started");
        expect(starts).toHaveLength(attempt + 2);
        for (const start of starts) expect(pidAlive(start.pid)).toBe(false);
        expect(records.filter((entry) => entry.type === "prompt").map((entry) => entry.message))
          .toEqual(priorStatus === "interrupted" ? ["hold old task"] : []);
        previous = failed;
        previousCompletionId = completion.id;
      }
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
      delete process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES;
    }
  });
});

describe("child process lifecycle", () => {
  test.each(["completed", "failed", "interrupted"] as const)("preserves the previous %s result when shutdown cancels a pending restart", async (status) => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = `shutdown-pending-restart-${status}`;
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    const firstMessage = status === "failed" ? "fail first" : status === "interrupted" ? "hold first" : "first";
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", firstMessage));
      if (status === "interrupted") await manager.interruptAgent(parentSessionId, "worker");
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === status && !info.childProcess;
      });
      const previous = manager.getAgentInfo("worker", parentSessionId);
      const previousCompletionIds = completions.map((event) => event.id);
      process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES = JSON.stringify({ holdOn: "get_state" });
      const pending = manager.sendMessage(parentSessionId, "worker", "must not run").then(
        () => undefined, (error: unknown) => error,
      );
      await waitUntil(() => Boolean(manager["live"].get(previous.id)?.pending.size));
      await manager.shutdown();
      expect(await pending).toBeInstanceOf(Error);
      const after = manager.getAgentInfo("worker", parentSessionId);
      expect(after).toMatchObject({ status, messageCount: previous.messageCount });
      expect(after.completedAt).toBe(previous.completedAt);
      expect(after.finalResponse).toBe(previous.finalResponse);
      expect(after.error).toBe(previous.error);
      expect(after.childProcess).toBeUndefined();
      expect(manager["live"].has(previous.id)).toBe(false);
      expect(completions.map((event) => event.id)).toEqual(previousCompletionIds);
      const records = fs.readFileSync(after.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records.filter((entry) => entry.type === "prompt").map((entry) => entry.message)).toEqual([firstMessage]);
      const starts = records.filter((entry) => entry.type === "started");
      expect(starts).toHaveLength(2);
      for (const start of starts) expect(pidAlive(start.pid)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
      delete process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES;
    }
  });

  test("hibernates after settle and lazily restarts the persisted session", async () => {
    fs.rmSync(path.join(TEST_AGENT_DIR, "pi-codex-subagents", "config.json"), { force: true });
    fs.rmSync(path.join(TEST_AGENT_DIR, "pi-codex-subagents", "SYSTEM.md"), { force: true });
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-settle";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"));
      const first = manager.getAgentInfo("worker", parentSessionId);
      const firstPid = first.childProcess!.pid;
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "completed" && !info.childProcess;
      });
      expect(pidAlive(firstPid)).toBe(false);
      expect(manager.readAgentResponse("worker", parentSessionId).finalResponse).toBe("response:first");

      expect(await manager.sendMessage(parentSessionId, "worker", "second")).toEqual({ delivery: "prompt" });
      const secondPid = manager.getAgentInfo("worker", parentSessionId).childProcess!.pid;
      expect(secondPid).not.toBe(firstPid);
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "completed" && !info.childProcess;
      });
      expect(pidAlive(secondPid)).toBe(false);
      expect(manager.readAgentResponse("worker", parentSessionId).finalResponse).toBe("response:second");
      const sessionRecords = fs.readFileSync(first.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const starts = sessionRecords.filter((entry) => entry.type === "started");
      expect(new Set(starts.map((entry) => entry.pid)).size).toBe(2);
      const systemPromptIndex = starts[0].args.indexOf("--system-prompt");
      const systemPromptPath = starts[0].args[systemPromptIndex + 1];
      expect(path.isAbsolute(systemPromptPath)).toBe(true);
      expect(fs.readFileSync(systemPromptPath, "utf8")).toBe("You are a subagent working for a main agent. Work only on the assigned task and follow its scope precisely.");
      for (const start of starts) {
        expect(start.args).toContain("--no-context-files");
        expect(start.args.slice(start.args.indexOf("--system-prompt"), start.args.indexOf("--system-prompt") + 2)).toEqual([
          "--system-prompt",
          systemPromptPath,
        ]);
        expect(start.args.slice(start.args.indexOf("--append-system-prompt"), start.args.indexOf("--append-system-prompt") + 2)).toEqual([
          "--append-system-prompt",
          "",
        ]);
      }
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("records startup failure causes instead of leaving agents starting", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-startup-failure";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    // Marker files live in the isolated temp directory, not the Windows named-pipe namespace.
    const socketDir = path.join(TEST_AGENT_DIR, "pi-codex-subagents", os.userInfo().username, "sockets");
    fs.rmSync(scope, { recursive: true, force: true });
    const manager = new AgentManager();
    await manager.ready();
    fs.rmSync(socketDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(socketDir), { recursive: true });
    fs.writeFileSync(socketDir, "block startup marker creation");
    try {
      let returnedError = "";
      try {
        await manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"));
      } catch (error) {
        returnedError = error instanceof Error ? error.message : String(error);
      }
      expect(returnedError).toContain("EEXIST");
      const failed = manager.getAgentInfo("worker", parentSessionId);
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe(returnedError);
      expect(failed.childProcess).toBeUndefined();
      expect((await manager.waitAllAgents(parentSessionId, ["worker"])).responses).toEqual([
        expect.objectContaining({ agent_name: "/worker", status: "failed", error: failed.error }),
      ]);

      fs.rmSync(socketDir, { force: true });
      fs.mkdirSync(socketDir, { recursive: true });
      expect(await manager.sendMessage(parentSessionId, "worker", "retry")).toEqual({ delivery: "prompt" });
      await waitUntil(() => manager.getAgentInfo("worker", parentSessionId).status === "completed");
    } finally {
      fs.rmSync(socketDir, { recursive: true, force: true });
      fs.mkdirSync(socketDir, { recursive: true });
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("reconciles persisted startup records that never acquired a child", async () => {
    const parentSessionId = "lifecycle-reconcile-no-child";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    const id = "33333333-3333-4333-8333-333333333333";
    const infoFile = path.join(scope, `${id}.info.json`);
    fs.rmSync(scope, { recursive: true, force: true });
    fs.mkdirSync(scope, { recursive: true });
    fs.writeFileSync(infoFile, JSON.stringify({
      id,
      taskName: "orphan",
      canonicalName: "/orphan",
      parentSessionId,
      provider: "test",
      modelId: "fake",
      model: "test:fake",
      cwd: TEST_AGENT_DIR,
      sessionFile: path.join(scope, `${id}.jsonl`),
      infoFile,
      logFile: path.join(scope, `${id}.log`),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      status: "starting",
    }));
    const manager = new AgentManager();
    try {
      await manager.ready();
      expect(manager.getAgentInfo("orphan", parentSessionId)).toMatchObject({
        status: "failed",
        error: "Agent startup did not complete before its owning extension stopped.",
      });
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test("hibernates after failure while preserving the error", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-failure";
    const systemPromptFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "SYSTEM.md");
    const customSystemPrompt = "Use the custom subagent instructions.";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(systemPromptFile), { recursive: true });
    fs.writeFileSync(systemPromptFile, customSystemPrompt);
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "fail now"));
      const started = manager.getAgentInfo("worker", parentSessionId);
      const pid = started.childProcess!.pid;
      expect(fs.readFileSync(systemPromptFile, "utf8")).toBe(customSystemPrompt);
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "failed" && !info.childProcess;
      });
      const failed = manager.readAgentResponse("worker", parentSessionId);
      expect(failed.error).toBe("fake failure");
      expect(pidAlive(pid)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
      fs.rmSync(systemPromptFile, { force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("rejects an empty configured system prompt instead of falling back to Pi's default", async () => {
    const parentSessionId = "empty-system-prompt";
    const systemPromptFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "SYSTEM.md");
    fs.mkdirSync(path.dirname(systemPromptFile), { recursive: true });
    fs.writeFileSync(systemPromptFile, "\n");
    const manager = new AgentManager();
    try {
      await expect(manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"))).rejects.toThrow("Subagent system prompt is empty");
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
      fs.rmSync(systemPromptFile, { force: true });
    }
  });

  test.skipIf(process.platform === "win32")("accepts Darwin process ownership when ps cannot expose the token", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-darwin";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "hold darwin"));
      const running = manager.getAgentInfo("worker", parentSessionId);
      expect(running.childProcess?.pid).toBeNumber();
      expect(pidAlive(running.childProcess!.pid)).toBe(true);
    } finally {
      try {
        await manager.shutdown();
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
        fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
        delete process.env.PI_SUBAGENT_PI_BIN;
      }
    }
  });

  test("broadcasts delta-only tool-call progress instead of reporting thinking", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-delta-only-progress";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const manager = new AgentManager({ modelResponseTimeoutMs: 2000 });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "stream forever"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const running = manager.getAgentInfo("worker", parentSessionId);
      const [sync, update] = await readSocketEvents(getSocketPath(running.id), 2);
      expect(sync.status).toBe("calling");
      expect(sync.partialMessage.content[0]).toMatchObject({ type: "toolCall" });
      expect(update.type).toBe("message_update");
      expect(update.message).toBeUndefined();

      const persistedActivity = manager.getAgentInfo("worker", parentSessionId).updatedAt;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(manager.getAgentInfo("worker", parentSessionId).updatedAt).toBe(persistedActivity);
    } finally {
      await manager.interruptAgent(parentSessionId, "worker");
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("does not apply the model response timeout to tool execution", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-tool-timeout";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const manager = new AgentManager({ modelResponseTimeoutMs: 50 });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "tool hold"));
      const pid = manager.getAgentInfo("worker", parentSessionId).childProcess!.pid;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(manager.getAgentInfo("worker", parentSessionId).status).toBe("running");
      expect(pidAlive(pid)).toBe(true);
    } finally {
      await manager.interruptAgent(parentSessionId, "worker");
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("fails and terminates a model response that streams forever", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-model-response-timeout";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const manager = new AgentManager({ modelResponseTimeoutMs: 50 });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "stream forever"));
      const pid = manager.getAgentInfo("worker", parentSessionId).childProcess!.pid;
      await waitUntil(() => {
        const info = manager.getAgentInfo("worker", parentSessionId);
        return info.status === "failed" && !info.childProcess;
      });
      expect(manager.readAgentResponse("worker", parentSessionId).error).toContain("Model response exceeded 50 ms");
      expect(pidAlive(pid)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("interrupt terminates the child and clears runtime artifacts", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-interrupt";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "hold interrupt"));
      const running = manager.getAgentInfo("worker", parentSessionId);
      const pid = running.childProcess!.pid;
      expect((await manager.interruptAgent(parentSessionId, "worker")).previous_status).toBe("running");
      const interrupted = manager.getAgentInfo("worker", parentSessionId);
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.childProcess).toBeUndefined();
      expect(pidAlive(pid)).toBe(false);
      const socketDir = path.join(process.env.PI_SUBAGENT_TEMP_DIR!, "pi-codex-subagents", os.userInfo().username, "sockets");
      expect(fs.existsSync(path.join(socketDir, `${running.id}.active.json`))).toBe(false);
      expect(fs.existsSync(path.join(socketDir, `${running.id}.peek.json`))).toBe(false);
      if (process.platform !== "win32") expect(fs.existsSync(getSocketPath(running.id))).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("reconciles owned children without risking PID-reuse kills", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "lifecycle-reconcile";
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    const owner = new AgentManager();
    const reconcilers: Array<InstanceType<typeof AgentManager>> = [];
    try {
      await owner.spawnAgent(spawnParams(parentSessionId, "orphan", "hold orphan"));
      const orphanPid = owner.getAgentInfo("orphan", parentSessionId).childProcess!.pid;
      const reconciler = new AgentManager();
      reconcilers.push(reconciler);
      await waitUntil(() => {
        const info = reconciler.getAgentInfo("orphan", parentSessionId);
        return info.status === "interrupted" && !info.childProcess;
      });
      await waitUntil(() => !pidAlive(orphanPid));
      expect(pidAlive(orphanPid)).toBe(false);

      await owner.spawnAgent(spawnParams(parentSessionId, "pid-reuse", "hold identity"));
      const mismatched = owner.getAgentInfo("pid-reuse", parentSessionId);
      const mismatchedPid = mismatched.childProcess!.pid;
      mismatched.childProcess!.processIdentity = "not-the-owned-process";
      fs.writeFileSync(mismatched.infoFile, JSON.stringify(mismatched, null, 2));
      const mismatchReconciler = new AgentManager();
      reconcilers.push(mismatchReconciler);
      await waitUntil(() => {
        const info = mismatchReconciler.getAgentInfo("pid-reuse", parentSessionId);
        return info.status === "interrupted" && !info.childProcess;
      });
      expect(pidAlive(mismatchedPid)).toBe(true);
      await owner.shutdown();
      expect(pidAlive(mismatchedPid)).toBe(false);
    } finally {
      await Promise.all([owner.shutdown(), ...reconcilers.map((manager) => manager.shutdown())]);
      fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });
});

describe("completion delivery", () => {
  test("publishes unclaimed settled and abnormal-exit completions", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "completion-callbacks";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event: any) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "settled", "first"));
      await waitUntil(() => completions.some((event) => event.agentName === "/settled"));
      expect(completions.filter((event) => event.agentName === "/settled")).toHaveLength(1);
      expect(completions.find((event) => event.agentName === "/settled")).toMatchObject({
        status: "completed",
        finalResponse: "response:first",
      });

      await manager.spawnAgent(spawnParams(parentSessionId, "crashed", "crash now"));
      await waitUntil(() => completions.some((event) => event.agentName === "/crashed"));
      expect(completions.filter((event) => event.agentName === "/crashed")).toHaveLength(1);
      expect(completions.find((event) => event.agentName === "/crashed")).toMatchObject({ status: "failed" });
      expect(completions.find((event) => event.agentName === "/crashed").error).toContain("code=23");
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("suppresses automatic delivery while wait tools claim completions", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "completion-waits";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event: any) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "one", "first"));
      const waited = await manager.waitAgent(parentSessionId, ["one"]);
      expect(waited.event).toMatchObject({ agentName: "/one", status: "completed" });
      expect(completions).toEqual([]);

      await manager.spawnAgent(spawnParams(parentSessionId, "two", "second"));
      const all = await manager.waitAllAgents(parentSessionId, ["two"]);
      expect(all.responses).toEqual([expect.objectContaining({ agent_name: "/two", status: "completed" })]);
      expect(completions).toEqual([]);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("releases suppressed completions when wait_all_agents is cancelled", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "completion-wait-cancel";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event: any) => completions.push(event) });
    const controller = new AbortController();
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "slow", "hold slow"));
      await manager.spawnAgent(spawnParams(parentSessionId, "fast", "fast"));
      const wait = manager.waitAllAgents(parentSessionId, ["slow", "fast"], controller.signal);
      await waitUntil(() => manager.getAgentInfo("fast", parentSessionId).status === "completed");
      expect(completions).toEqual([]);
      controller.abort(new Error("cancelled"));
      await expect(wait).rejects.toThrow("aborted");
      await waitUntil(() => completions.some((event) => event.agentName === "/fast"));
      expect(completions.filter((event) => event.agentName === "/fast")).toHaveLength(1);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });

  test("reports active and inactive lifecycle transitions", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const parentSessionId = "status-transitions";
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const activity: boolean[] = [];
    const manager = new AgentManager({
      onActivityChange: (event: any) => {
        if (event.parentSessionId === parentSessionId) activity.push(event.active);
      },
    });
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"));
      await waitUntil(() => manager.getAgentInfo("worker", parentSessionId).status === "completed");
      expect(activity).toContain(true);
      expect(activity.at(-1)).toBe(false);

      const settled = manager.getAgentInfo("worker", parentSessionId);
      const rejectedAt = activity.length;
      await expect(manager.sendMessage(parentSessionId, "worker", "reject restart")).rejects.toThrow("fake prompt rejection");
      expect(manager.getAgentInfo("worker", parentSessionId)).toMatchObject({
        status: "completed",
        finalResponse: settled.finalResponse,
        completedAt: settled.completedAt,
      });
      expect(manager.getAgentInfo("worker", parentSessionId).childProcess).toBeUndefined();
      expect(activity.slice(rejectedAt)).toContain(true);
      expect(activity.at(-1)).toBe(false);

      const restartAt = activity.length;
      await manager.sendMessage(parentSessionId, "worker", "hold restart");
      expect(activity.slice(restartAt)).toContain(true);
      await manager.interruptAgent(parentSessionId, "worker");
      expect(activity.at(-1)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });
});

describe("extension completion delivery and TUI", () => {
  test("collects native codemode renderers through the real extension API without registering or activating another tool", async () => {
    const { default: subagentExtension } = await import("./index.js");
    const accesses: PropertyKey[] = [];
    let collected: ToolRenderers | undefined;
    const loader = new codingAgent.DefaultResourceLoader({
      cwd: TEST_AGENT_DIR, agentDir: TEST_AGENT_DIR,
      settingsManager: codingAgent.SettingsManager.inMemory({}),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        codingAgent.createCodemodeExtension(),
        async (pi) => {
          const registerTool = pi.registerTool;
          // A diagnostic proxy over a complete real API checks the native factory's loading contract.
          await codingAgent.createCodemodeExtension()(new Proxy({
            ...pi,
            registerTool(definition) {
              expect(definition.name).toBe("codemode");
              const renderers = codingAgent.defineTool(definition);
              collected = {
                renderShell: renderers.renderShell, renderCall: renderers.renderCall, renderResult: renderers.renderResult,
              };
            },
          }, {
            get(target, key, receiver) {
              accesses.push(key);
              return Reflect.get(target, key, receiver);
            },
          }));
          await subagentExtension(pi);
          expect(pi.registerTool).toBe(registerTool);
        },
      ],
    });
    try {
      await loader.reload();
      const loaded = loader.getExtensions();
      expect(loaded.errors).toEqual([]);
      expect(loaded.extensions).toHaveLength(2);
      expect(accesses).toEqual(["registerTool"]);
      const [native, subagents] = loaded.extensions;
      const definition = native.tools.get("codemode")!.definition;
      expect(definition.defaultActive).toBe(false);
      expect(collected!.renderCall).toBe(definition.renderCall);
      expect(collected!.renderResult).toBe(definition.renderResult);
      expect([...native.tools.keys()]).toEqual(["codemode"]);
      expect([...subagents.tools.keys()]).toEqual([
        "spawn_agent", "wait_agent", "wait_all_agents", "list_agents", "read_agent_response", "send_message", "interrupt_agent",
      ]);
      // Session actions are still unbound: initialization did not activate tools or execute scripts.
      expect(() => loaded.runtime.getActiveTools()).toThrow("Extension runtime not initialized");

      // Exercise index.ts's actual overlay entry with current host display settings.
      const parentId = "renderer-contract-parent";
      const scope = path.join(getRunsDir(), parentScopeKey(parentId));
      fs.mkdirSync(scope, { recursive: true });
      const id = randomUUID();
      const info: AgentInfo = {
        id, parentSessionId: parentId, taskName: "contract", canonicalName: "/contract", status: "completed",
        cwd: TEST_AGENT_DIR, provider: "test", modelId: "fake", model: "test:fake",
        createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0,
        sessionFile: path.join(scope, `${id}.jsonl`), infoFile: path.join(scope, `${id}.info.json`),
        logFile: path.join(scope, `${id}.log`),
      };
      fs.writeFileSync(info.infoFile, JSON.stringify(info));
      const settings = { terminal: { showImages: false, imageWidthCells: 42 }, outputPad: 0 as const };
      loaded.runtime.getSettings = mock(() => settings);
      let opened = 0;
      const ctx: any = {
        mode: "tui", sessionManager: { getSessionId: () => parentId },
        ui: {
          async custom(create: any) {
            const component = create({ terminal: { rows: 80 }, requestRender() {} },
              { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, () => {});
            if (opened++ === 0) return { task: "contract", parentSessionId: parentId, includeAll: false };
            try {
              expect(component).toBeInstanceOf(SubagentPeekOverlay);
              expect(component["nativeCodemodeRenderers"]).toEqual(collected);
              expect(Object.keys(component["nativeCodemodeRenderers"])).toEqual(["renderShell", "renderCall", "renderResult"]);
              expect(component["toolExecutionOptions"]).toEqual({ showImages: false, imageWidthCells: 42, outputPad: 0 });
              component.handleInput("\x0f");
              expect(component["disposed"]).toBe(false);
            } finally {
              component.dispose();
            }
            return undefined;
          },
        },
      };
      try {
        await subagents.commands.get("subagents")!.handler("", ctx);
        expect(opened).toBe(2);
        expect(loaded.runtime.getSettings).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(scope, { recursive: true, force: true });
      }
    } finally {
      for (const extension of loader.getExtensions().extensions) {
        for (const shutdown of extension.handlers.get("session_shutdown") ?? []) {
          await shutdown({ type: "session_shutdown" }, {} as any);
        }
      }
    }
  });

  test("loads the TypeScript extension entry through Pi's file loader in an isolated process", () => {
    const agentDir = fs.mkdtempSync(path.join(TEST_AGENT_DIR, "file-loader-"));
    const source = `
      import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
      const loader = new DefaultResourceLoader({
        cwd: ${JSON.stringify(agentDir)}, agentDir: ${JSON.stringify(agentDir)},
        settingsManager: SettingsManager.inMemory({}),
        additionalExtensionPaths: [${JSON.stringify(path.join(import.meta.dir, "index.ts"))}],
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      });
      try {
        await loader.reload();
        const loaded = loader.getExtensions();
        if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
        console.log(JSON.stringify(loaded.extensions.map(extension => [...extension.tools.keys()])));
      } finally {
        for (const extension of loader.getExtensions().extensions) {
          for (const shutdown of extension.handlers.get("session_shutdown") ?? []) {
            await shutdown({ type: "session_shutdown" }, {});
          }
        }
      }
    `;
    try {
      const probe = spawnSync(process.execPath, ["--eval", source], {
        cwd: import.meta.dir, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_TEMP_DIR: agentDir },
      });
      if (probe.status !== 0) throw new Error(`Pi file-loader check failed: ${probe.error ?? probe.stderr}`);
      expect(JSON.parse(probe.stdout)).toEqual([[
        "spawn_agent", "wait_agent", "wait_all_agents", "list_agents", "read_agent_response", "send_message", "interrupt_agent",
      ]]);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test.each([undefined, "", "ctrl+shift+a"])("opens the browser with optional shortcut %s", async (shortcut) => {
    const configFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "config.json");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ shortcut }));
    const commands = new Map<string, any>();
    const shortcuts = new Map<string, any>();
    let shutdown: (() => Promise<void>) | undefined;
    let menusOpened = 0;
    const ctx: any = {
      mode: "tui",
      sessionManager: { getSessionId: () => "shortcut-test-parent" },
      ui: {
        async custom(create: any) {
          const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
          const menu = create({ requestRender() {} }, theme, {}, () => {});
          try {
            expect(menu.render(80).join("\n")).toContain("Subagents");
            menusOpened++;
            return undefined;
          } finally {
            menu.dispose?.();
          }
        },
      },
    };
    const { default: subagentExtension } = await import("./index.js");
    try {
      await subagentExtension({
        on(name: string, handler: any) { if (name === "session_shutdown") shutdown = handler; },
        registerTool() {},
        registerMessageRenderer() {},
        registerCommand(name: string, command: any) { commands.set(name, command); },
        registerShortcut(key: string, options: any) { shortcuts.set(key, options); },
      } as any);
      expect([...commands.keys()]).toEqual(["subagents"]);
      expect([...shortcuts.keys()]).toEqual(shortcut ? [shortcut] : []);
      await commands.get("subagents").handler("", ctx);
      expect(menusOpened).toBe(1);
      if (shortcut) {
        await shortcuts.get(shortcut).handler(ctx);
        expect(menusOpened).toBe(2);
      }
    } finally {
      await shutdown?.();
      fs.rmSync(configFile, { force: true });
    }
  });

  describe("agent browser", () => {
    async function withBrowser(run: (fixture: any) => Promise<void>) {
      const parentId = `browser-${randomUUID()}`;
      const otherId = `other-${randomUUID()}`;
      const scopes = new Set<string>();
      const records = new Map<string, AgentInfo>();
      let sequence = 0;
      const put = (name: string, overrides: Partial<AgentInfo> = {}, parent = parentId) => {
        const scope = path.join(getRunsDir(), parentScopeKey(parent));
        scopes.add(scope);
        fs.mkdirSync(scope, { recursive: true });
        const previous = records.get(`${parent}/${name}`);
        const id = previous?.id ?? randomUUID();
        const now = Date.now() + sequence++;
        const info: AgentInfo = {
          id, taskName: name, canonicalName: `/${name}`, parentSessionId: parent,
          status: "completed", cwd: TEST_AGENT_DIR, provider: "test", modelId: "fake", thinking: "off",
          createdAt: now, updatedAt: now, messageCount: 0,
          infoFile: path.join(scope, `${id}.info.json`),
          sessionFile: path.join(scope, `${id}.jsonl`), logFile: path.join(scope, `${id}.log`),
          ...previous, ...overrides,
        };
        records.set(`${parent}/${name}`, info);
        fs.writeFileSync(info.infoFile, JSON.stringify(info));
        return info;
      };
      const commands = new Map<string, any>();
      let shutdown: (() => Promise<void>) | undefined;
      const { default: subagentExtension } = await import("./index.js");

      const originalList = AgentManager.prototype.listAgents;
      const originalInfo = AgentManager.prototype.getAgentInfo;
      const originalConnect = (SubagentPeekOverlay.prototype as any).connectSocket;
      const list = mock(function(this: AgentManager, ...args: Parameters<AgentManager["listAgents"]>) {
        return originalList.apply(this, args);
      });
      AgentManager.prototype.listAgents = list;
      (SubagentPeekOverlay.prototype as any).connectSocket = () => {};
      const requestRender = mock(() => {});
      const selections: any[] = [];
      const opened: AgentInfo[] = [];
      const notify = mock((_message: string, _level?: string) => {});
      const theme = {
        ansi: "",
        fg(_color: string, text: string) { return this.ansi ? `${this.ansi}${text}\x1b[0m` : text; },
        bold: (text: string) => text,
      };
      const ctx: any = { mode: "tui", sessionManager: { getSessionId: () => parentId }, ui: { notify } };
      const fixture = {
        parentId, otherId, put, list, selections, opened, ctx, theme, requestRender, notify,
        tui: { terminal: { rows: 40 }, requestRender } as any,
        remove(info: AgentInfo) { fs.rmSync(info.infoFile, { force: true }); },
        command: () => commands.get("subagents").handler("", ctx),
        async open(interact: (browser: any) => any, overlay?: (component: any, index: number) => any) {
          ctx.ui.custom = async (create: any) => {
            let component: any;
            let result: any;
            const done = (value: any) => {
              result = value;
              if (!(component instanceof SubagentPeekOverlay)) selections.push(value);
              component?.dispose?.();
            };
            component = create(fixture.tui, theme, {}, done);
            try {
              if (component instanceof SubagentPeekOverlay) {
                opened.push(component["info"]);
                await overlay?.(component, opened.length - 1);
              } else {
                await interact(component);
              }
              return result;
            } finally {
              component.dispose?.();
            }
          };
          await fixture.command();
        },
      };
      try {
        await subagentExtension({
          on(name: string, handler: any) { if (name === "session_shutdown") shutdown = handler; },
          registerTool() {}, registerMessageRenderer() {},
          registerCommand(name: string, command: any) { commands.set(name, command); },
          registerShortcut() {},
          getSettings: () => ({ terminal: { showImages: false }, outputPad: 0 }),
        } as any);
        await run(fixture);
      } finally {
        await shutdown?.();
        AgentManager.prototype.listAgents = originalList;
        AgentManager.prototype.getAgentInfo = originalInfo;
        (SubagentPeekOverlay.prototype as any).connectSocket = originalConnect;
        for (const scope of scopes) fs.rmSync(scope, { recursive: true, force: true });
      }
    }

    const selectedRow = (browser: any, width = 120) =>
      stripVTControlCharacters(browser.render(width).find((line: string) => stripVTControlCharacters(line).startsWith("› ")) ?? "");

    test("shows task previews only when present, without context or new timers", async () => {
      const originalSet = globalThis.setInterval;
      const interval = mock(() => { throw new Error("The browser must not create an interval"); });
      globalThis.setInterval = interval as any;
      try {
        await withBrowser(async (f) => {
          f.put("review", { createdAt: 300, lastTaskMessage: "中文任务 \n preview", contextUsage: { tokens: 50000, contextWindow: 500000, percent: 10 } });
          f.put("plain", { createdAt: 200 });
          f.put("empty", { createdAt: 100, lastTaskMessage: "" });
          await f.open((browser: any) => {
            const lines = browser.render(120);
            const review = lines.findIndex((line: string) => line.includes("/review"));
            const plain = lines.findIndex((line: string) => line.includes("/plain"));
            const empty = lines.findIndex((line: string) => line.includes("/empty"));
            expect(lines[review + 1]).toBe("  中文任务 preview");
            expect(plain).toBe(review + 2);
            expect(empty).toBe(plain + 1);
            expect(lines[empty + 1]).toBe("");
            expect(lines.join("\n")).not.toContain("ctx");
            expect(lines.join("\n")).not.toContain("10%/500k");
            browser.handleInput("q");
          });
        });
        expect(interval).not.toHaveBeenCalled();
      } finally {
        globalThis.setInterval = originalSet;
      }
    });

    test("refreshes saved metadata and previews with r", async () => {
      await withBrowser(async (f) => {
        f.put("live", { status: "running", lastTaskMessage: "initial preview" });
        await f.open((browser: any) => {
          const first = browser.render(80);
          f.put("live", { status: "completed", lastTaskMessage: "updated preview" });
          expect(browser.render(80)).toBe(first);
          const reads = f.list.mock.calls.length;
          browser.handleInput("r");
          expect(f.requestRender).toHaveBeenCalledTimes(1);
          expect(f.list).toHaveBeenCalledTimes(reads);
          const refreshed = browser.render(80).join("\n");
          expect(refreshed).toContain("completed");
          expect(refreshed).toContain("updated preview");
          expect(refreshed).not.toContain("initial preview");
          browser.handleInput("q");
        });
      });
    });

    test("navigates pages and clamps selection after deletion or an empty list", async () => {
      await withBrowser(async (f) => {
        const history = Array.from({ length: 12 }, (_, index) => f.put(`history/${index}`, { createdAt: 100 - index }));
        await f.open((browser: any) => {
          expect(browser.render(120).join("\n")).toContain("↓ 2 more");
          for (let index = 0; index < 11; index++) {
            browser.handleInput(index % 2 ? "j" : "\x1b[B");
            browser.render(120);
          }
          expect(selectedRow(browser)).toContain("/history/11");
          expect(browser.render(120).join("\n")).toContain("↑ 2 more");
          browser.handleInput("\x1b[A");
          expect(selectedRow(browser)).toContain("/history/10");
          browser.handleInput("k");
          expect(selectedRow(browser)).toContain("/history/9");
          browser.handleInput("j");
          browser.render(120);
          browser.handleInput("j");
          browser.render(120);
          f.remove(history[11]);
          f.remove(history[10]);
          browser.handleInput("r");
          expect(selectedRow(browser)).toContain("/history/9");
          for (const info of history) f.remove(info);
          browser.handleInput("r");
          expect(browser.render(80).join("\n")).toContain("No subagents for this session");
          for (const key of ["j", "k", "\x1b[A", "\x1b[B", "\r"]) browser.handleInput(key);
          expect(f.selections).toEqual([]);
          f.put("returned");
          browser.handleInput("r");
          expect(selectedRow(browser)).toContain("/returned");
          browser.handleInput("\r");
        });
        expect(f.opened.map((info: AgentInfo) => info.canonicalName)).toEqual(["/returned"]);
      });
    });

    test.each(["unrefreshed", "r pending", "scope pending", "selection pending"])("Enter uses the displayed item after insertion (%s)", async (refresh) => {
      await withBrowser(async (f) => {
        f.put("first", { createdAt: 200 });
        f.put("target", { createdAt: 100 });
        await f.open((browser: any) => {
          browser.render(120);
          browser.handleInput("j");
          expect(selectedRow(browser)).toContain("/target");
          f.put("inserted", { createdAt: 300 });
          if (refresh === "r pending") browser.handleInput("r");
          if (refresh === "scope pending") browser.handleInput("\t");
          if (refresh === "selection pending") browser.handleInput("k");
          const reads = f.list.mock.calls.length;
          browser.handleInput("\r");
          expect(f.list).toHaveBeenCalledTimes(reads);
        });
        expect(f.selections).toEqual([{ task: "/target", parentSessionId: f.parentId, includeAll: false }]);
        expect(f.opened[0].canonicalName).toBe("/target");
      });
    });

    test("skips a record lost between list and detail reads, then safely selects a survivor", async () => {
      await withBrowser(async (f) => {
        const gone = f.put("gone", { createdAt: 200 });
        f.put("survivor", { createdAt: 100 });
        const getInfo = AgentManager.prototype.getAgentInfo;
        AgentManager.prototype.getAgentInfo = function(target, parent) {
          if (target === "/gone") f.remove(gone);
          return getInfo.call(this, target, parent);
        };
        await f.open((browser: any) => {
          expect(() => browser.render(80)).not.toThrow();
          expect(browser.render(80).join("\n")).not.toContain("/gone");
          browser.handleInput("\r");
          expect(f.selections).toEqual([]);
          browser.handleInput("r");
          expect(selectedRow(browser)).toContain("/survivor");
          browser.handleInput("\r");
        });
        expect(f.opened[0].canonicalName).toBe("/survivor");
      });
    });

    test("does not open a different agent when the displayed Enter target disappears", async () => {
      await withBrowser(async (f) => {
        const gone = f.put("gone", { createdAt: 200 });
        f.put("survivor", { createdAt: 100 });
        await f.open((browser: any) => {
          browser.render(80);
          f.remove(gone);
          browser.handleInput("\r");
        });
        expect(f.selections[0].task).toBe("/gone");
        expect(f.opened).toEqual([]);
        expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("Agent not found"), "error");
      });
    });

    test.each([["\x1b[D", "previous"], ["\x1b[C", "next"]])("handles a disappearing %s overlay navigation target", async (key, direction) => {
      await withBrowser(async (f) => {
        const previous = f.put("previous", { createdAt: 300 });
        f.put("middle", { createdAt: 200 });
        const next = f.put("next", { createdAt: 100 });
        const list = AgentManager.prototype.listAgents;
        let navigating = false;
        AgentManager.prototype.listAgents = function(...args) {
          const entries = list.apply(this, args);
          if (navigating) f.remove(direction === "next" ? next : previous);
          return entries;
        };
        await f.open((browser: any) => {
          browser.render(120);
          browser.handleInput("j");
          expect(selectedRow(browser)).toContain("/middle");
          browser.handleInput("\r");
        }, (overlay: any) => {
          navigating = true;
          overlay.handleInput(key);
        });
        expect(f.opened.map((info: AgentInfo) => info.canonicalName)).toEqual(["/middle"]);
        expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("Agent not found"), "error");
      });
    });

    test("all-session browsing distinguishes identical names and remains read-only", async () => {
      await withBrowser(async (f) => {
        const own = f.put("same", { modelId: "own-model" });
        const other = f.put("same", { modelId: "other-model" }, f.otherId);
        const before = [own, other].map((info) => fs.readFileSync(info.infoFile, "utf8"));
        const controlNames = ["spawnAgent", "sendMessage", "interruptAgent", "sendCommand"] as const;
        const originals = controlNames.map((name) => (AgentManager.prototype as any)[name]);
        const controls = controlNames.map((name) => {
          const control = mock(() => { throw new Error(`Browser must not call ${name}`); });
          (AgentManager.prototype as any)[name] = control;
          return control;
        });
        try {
          await f.open((browser: any) => {
            expect(browser.render(120).join("\n")).not.toContain("other-model");
            browser.handleInput("\t");
            const lines = browser.render(120).join("\n");
            expect(lines).toContain("own-model");
            expect(lines).toContain("other-model");
            expect(selectedRow(browser)).toEndWith(f.otherId.slice(-8));
            browser.handleInput("j");
            expect(selectedRow(browser)).toEndWith(f.parentId.slice(-8));
            browser.handleInput("\t");
            expect(selectedRow(browser)).toContain("/same");
            browser.handleInput("\t");
            expect(selectedRow(browser)).toEndWith(f.otherId.slice(-8));
            browser.handleInput("\r");
          }, (overlay: any, index: number) => overlay.handleInput(["\x1b[C", "\x1b[D", "q"][index]));
          expect(f.selections).toEqual([{ task: "/same", parentSessionId: f.otherId, includeAll: true }]);
          expect(f.opened.map((info: AgentInfo) => info.parentSessionId)).toEqual([f.otherId, f.parentId, f.otherId]);
          for (const control of controls) expect(control).not.toHaveBeenCalled();
          expect([own, other].map((info) => fs.readFileSync(info.infoFile, "utf8"))).toEqual(before);
        } finally {
          controlNames.forEach((name, index) => { (AgentManager.prototype as any)[name] = originals[index]; });
        }
      });
    });

    test("clips wide ANSI previews at 32/38/50/80/120 columns and invalidates theme caches", async () => {
      await withBrowser(async (f) => {
        const info = f.put("wide", {
          canonicalName: "/中文很长的名称".repeat(6), modelId: "宽模型".repeat(10),
          lastTaskMessage: "\x1b[31m中文任务 😀\tcombining é ".repeat(20) + "\x1b[0m",
        });
        // Task creation restricts names to ASCII; exercise rendering of wide historical labels directly.
        const getInfo = AgentManager.prototype.getAgentInfo;
        AgentManager.prototype.getAgentInfo = function(target, parent) {
          return target === info.canonicalName ? info : getInfo.call(this, target, parent);
        };
        f.theme.ansi = "\x1b[36m";
        await f.open((browser: any) => {
          for (const width of [32, 38, 50, 80, 120]) {
            const lines = browser.render(width);
            expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
            const preview = lines.map(stripVTControlCharacters).find((line: string) => line.startsWith("  中文任务"));
            expect(preview).toStartWith("  中文任务 😀");
            expect(lines.join("\n")).not.toContain("\t");
          }
          const first = browser.render(120);
          expect(first.join("\n")).toContain("\x1b[36m");
          f.theme.ansi = "\x1b[35m";
          browser.invalidate();
          const themed = browser.render(120).join("\n");
          expect(themed).toContain("\x1b[35m");
          expect(themed).not.toContain("\x1b[36m");
          browser.handleInput("q");
        });
      });
    });

    test.each(["regular", "fullscreen"] as const)("native %s TUI list supports manual refresh and resize", async (mode) => {
      await withBrowser(async (f) => {
        f.put("native", { lastTaskMessage: "中文任务 ".repeat(30) });
        let input: (data: string) => void = () => {};
        let resize = () => {};
        const writes: string[] = [];
        const terminal: Terminal & { columns: number; rows: number } = {
          columns: 120, rows: 35, kittyProtocolActive: false,
          start(onInput, onResize) { input = onInput; resize = onResize; },
          stop() {}, async drainInput() {}, write(data) { writes.push(data); },
          moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
          clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
        };
        const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
        f.tui = tui;
        await f.open((browser: any) => {
          tui.addChild(browser);
          tui.setFocus(browser);
          tui.start();
          const draw = () => {
            writes.length = 0;
            tui.renderNow(true);
            return stripVTControlCharacters(writes.join(""));
          };
          try {
            expect(draw()).toContain("中文任务");
            f.put("native", { lastTaskMessage: "updated preview" });
            input("r");
            expect(draw()).toContain("updated preview");
            for (const width of [32, 38, 50, 80, 120]) {
              terminal.columns = width;
              resize();
              expect(draw()).toContain("updated preview");
              expect(browser.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
            }
            input("\x1b");
            expect(f.selections).toEqual([undefined]);
          } finally {
            tui.stop();
          }
        });
      });
    });

    test("does not construct a browser outside TUI mode", async () => {
      await withBrowser(async (f) => {
        f.ctx.mode = "rpc";
        f.ctx.ui.custom = mock(() => { throw new Error("custom is unavailable"); });
        await f.command();
        expect(f.ctx.ui.custom).not.toHaveBeenCalled();
        expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("interactive TUI"), "warning");
      });
    });
  });

  test("registers commands, renders one-line activity, and delivers bounded completions", async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const renderers = new Map<string, any>();
    const sentMessages: Array<{ message: any; options: any }> = [];
    let widget: any;
    const pi: any = {
      on(name: string, handler: (event: any, ctx: any) => any) {
        const entries = handlers.get(name) ?? [];
        entries.push(handler);
        handlers.set(name, entries);
      },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      registerMessageRenderer(name: string, renderer: any) { renderers.set(name, renderer); },
      sendMessage(message: any, options: any) { sentMessages.push({ message, options }); },
      getThinkingLevel() { return "high"; },
      getActiveTools() { return ["read", "bash"]; },
      getSettings() { return { terminal: { showImages: false, imageWidthCells: 42 }, outputPad: 0 }; },
    };
    const parentSessionId = "index-integration-parent";
    const availableModels = [
      { provider: "test", id: "fake" },
      { provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" },
      { provider: "openai", id: "gpt-5" },
    ];
    const notifications: string[] = [];
    const ctx: any = {
      cwd: TEST_AGENT_DIR,
      mode: "tui",
      model: { provider: "test", id: "fake" },
      modelRegistry: { getAvailable: () => availableModels },
      // What pi resolved the enabledModels patterns to for this session, availability-checked.
      scopedModels: [
        { model: { provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" } },
        { model: { provider: "openai", id: "gpt-5" } },
      ],
      sessionManager: {
        getSessionId: () => parentSessionId,
        getSessionFile: () => path.join(TEST_AGENT_DIR, "parent.jsonl"),
      },
      ui: {
        setWidget(_key: string, value: any) { widget = value; },
        notify(message: string) { notifications.push(message); },
      },
    };
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.rmSync(scope, { recursive: true, force: true });
    const configFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "config.json");
    const modelOnlyTemplateFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents", "current-parent.md");
    fs.writeFileSync(modelOnlyTemplateFile, "---\nname: current-parent\nmodel: template-model\n---\n");
    // A thinking suffix on an allowlist entry is tolerated and stripped from the offered pair.
    fs.writeFileSync(configFile, JSON.stringify({ models: ["test/fake:high", "typo/nope"], modelsFromEnabledModels: true }));
    const { default: subagentExtension } = await import("./index.js");
    await subagentExtension(pi);
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    };

    // Session start is the single resolution point, so before it the arguments are absent.
    const spawnArgs = () => tools.get("spawn_agent").parameters.properties;
    expect(spawnArgs().model).toBeUndefined();
    expect(spawnArgs().thinking).toBeUndefined();

    try {
      // Session start is authoritative: allowlist entries filtered to what is available,
      // unioned with pi's scoped models, and the schema must not wait for a first turn.
      await emit("session_start", { reason: "startup" });
      expect(spawnArgs().model.enum).toEqual(["test/fake", "fireworks/accounts/fireworks/models/glm-5p2", "openai/gpt-5"]);
      expect(spawnArgs().thinking.enum).toContain("max");
      expect(notifications).toEqual(['spawn_agent models not available: typo/nope']);
      // The values live in the schema, but the description has to say the capability exists.
      expect(tools.get("spawn_agent").description).toContain("`model` takes one of the values its schema lists");
      expect([...commands.keys()]).toEqual(["subagents"]);
      expect(renderers.has("pi-codex-subagent-completion")).toBe(true);

      fs.mkdirSync(scope, { recursive: true });
      const historyCreatedAt = Date.now();
      for (let index = 0; index < 12; index++) {
        const id = `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`;
        fs.writeFileSync(path.join(scope, `${id}.info.json`), JSON.stringify({
          id,
          taskName: `history/${index}`,
          canonicalName: `/history/${index}`,
          parentSessionId,
          status: index === 0 ? "running" : "completed",
          lastTaskMessage: `private task context ${index}`,
          provider: "test",
          modelId: index === 0 ? "MiniMax-M3" : "a-model-name-that-is-longer-than-the-column",
          thinking: index === 0 ? "high" : "medium",
          createdAt: historyCreatedAt - index,
          updatedAt: historyCreatedAt - index,
        }));
      }
      ctx.ui.custom = async (create: any) => {
        const browser = create({ requestRender() {} }, {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        }, {}, () => {});
        try {
          const browserLines = browser.render(120);
          const firstRowIndex = browserLines.findIndex((line: string) => line.includes("/history/0"));
          const firstRow = browserLines[firstRowIndex];
          expect(firstRow).toMatch(/\/history\/0\s+running\s+\S+\s+MiniMax-M3\s+high/);
          expect(browserLines[firstRowIndex + 1]).toContain("private task context 0");
          const secondRow = browserLines.find((line: string) => line.includes("/history/1 "));
          expect(secondRow.indexOf("a-model-name")).toBe(firstRow.indexOf("MiniMax-M3"));
          expect(visibleWidth(secondRow.slice(0, secondRow.indexOf("medium"))))
            .toBe(visibleWidth(firstRow.slice(0, firstRow.indexOf("high"))));
          expect(secondRow).not.toContain("a-model-name-that-is-longer-than-the-column");
          for (const width of [80, 50, 32]) {
            expect(browser.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
          }
          const narrowRow = browser.render(50).find((line: string) => line.includes("/history/0"));
          expect(narrowRow).toContain("high");
          expect(narrowRow).not.toContain("MiniMax-M3");
          browser.handleInput("\t");
          const allSessionRow = browser.render(80).find((line: string) => line.includes("/history/0"));
          expect(allSessionRow).toContain("MiniMax-M3");
          expect(allSessionRow).toContain("high");
          expect(allSessionRow.trimEnd()).toEndWith(parentSessionId.slice(-8));
          return undefined;
        } finally {
          browser.dispose?.();
        }
      };
      await commands.get("subagents").handler("", ctx);

      const firstAgentPage = await tools.get("list_agents").execute("list-1", {}, undefined, undefined, ctx);
      const firstAgentPayload = JSON.parse(firstAgentPage.content[0].text);
      expect(firstAgentPayload).toMatchObject({ total: 12, returned: 10, offset: 0, limit: 10, next_offset: 10 });
      expect(firstAgentPayload.agents[0]).toEqual({ agent_name: "/history/0", agent_status: "running" });
      expect(firstAgentPage.content[0].text).not.toContain("private task context");
      const secondAgentPage = await tools.get("list_agents").execute("list-2", { offset: 10 }, undefined, undefined, ctx);
      expect(JSON.parse(secondAgentPage.content[0].text)).toMatchObject({ total: 12, returned: 2, offset: 10, next_offset: null });

      const spawnResult = await tools.get("spawn_agent").execute("spawn-1", {
        task_name: "x".repeat(200),
        message: "slow finish",
      }, undefined, undefined, ctx);

      const spawnRendered = tools.get("spawn_agent").renderResult(spawnResult, {}, { fg: (_color: string, text: string) => text }).render(400);
      expect(spawnRendered.join("\n").trim()).toBe(`✓ ${spawnResult.details.task_name} · test/fake · high`);

      expect(widget).toBeFunction();
      const theme = { fg: (_color: string, text: string) => text };
      const lines = widget({}, theme).render(40);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0])).toBeLessThanOrEqual(40);
      expect(lines[0]).toContain("/subagents");

      await waitUntil(() => sentMessages.length === 1);
      expect(widget).toBeUndefined();
      expect(sentMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
      expect(sentMessages[0].message.content).toContain("response:slow finish");

      await tools.get("spawn_agent").execute("spawn-2", {
        task_name: "large-output",
        message: "large response",
      }, undefined, undefined, ctx);
      await waitUntil(() => sentMessages.length === 2);
      const large = sentMessages[1].message;
      expect(Buffer.byteLength(large.content, "utf8")).toBeLessThanOrEqual(50 * 1024);
      expect(large.content).toContain("Output truncated");
      expect(large.details.fullOutputPath).toBeString();
      expect(fs.existsSync(large.details.fullOutputPath)).toBe(true);

      await tools.get("spawn_agent").execute("spawn-3", {
        task_name: "routed",
        message: "slow finish",
        model: "fireworks/accounts/fireworks/models/glm-5p2",
        thinking: "max",
      }, undefined, undefined, ctx);
      expect(getAgent("routed", parentSessionId)).toMatchObject({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/glm-5p2",
        thinking: "max",
      });
      // A model the registry has, but neither list allows, is refused.
      await expect(tools.get("spawn_agent").execute("spawn-4", { task_name: "not-enabled", message: "x", model: "anthropic/claude-opus-4-6" }, undefined, undefined, ctx))
        .rejects.toThrow(/not in the configured spawn models/);

      // An allowlisted model whose provider dropped out mid-session is refused at spawn time,
      // covering both availability drift and schemas frozen before the session started.
      availableModels.splice(availableModels.findIndex((entry) => entry.provider === "openai"), 1);
      await expect(tools.get("spawn_agent").execute("spawn-5", { task_name: "gone", message: "x", model: "openai/gpt-5" }, undefined, undefined, ctx))
        .rejects.toThrow(/not currently available/);

      // Unconfigured takes both runtime arguments away again even though Pi still has enabledModels.
      fs.writeFileSync(configFile, "{}");
      await emit("session_start", { reason: "restart" });
      expect(spawnArgs().model).toBeUndefined();
      expect(spawnArgs().thinking).toBeUndefined();
      expect(tools.get("spawn_agent").description).not.toContain("`model` takes one of the values");
      expect(tools.get("spawn_agent").description).toContain("current parent provider at spawn");

      // Template models may exist only in the isolated child registry, not the parent registry or allowlist.
      await tools.get("spawn_agent").execute("spawn-model-only-1", {
        task_name: "model-only/current-provider", message: "hold model-only", agent_type: "current-parent",
      }, undefined, undefined, ctx);
      expect(getAgent("model-only/current-provider", parentSessionId)).toMatchObject({
        provider: "test", modelId: "template-model", thinking: "high",
      });
      // No session restart: each spawn must read the current parent provider, not a cached route.
      ctx.model = { provider: "template-provider", id: "parent-model" };
      availableModels.push(ctx.model);
      await tools.get("spawn_agent").execute("spawn-model-only-2", {
        task_name: "model-only/changed-provider", message: "hold changed provider", agent_type: "current-parent",
      }, undefined, undefined, ctx);
      expect(getAgent("model-only/changed-provider", parentSessionId)).toMatchObject({
        provider: "template-provider", modelId: "template-model", thinking: "high",
      });
      expect(getAgent("model-only/current-provider", parentSessionId)).toMatchObject({ provider: "test", modelId: "template-model" });
      expect(spawnArgs().model).toBeUndefined();
      expect(spawnArgs().thinking).toBeUndefined();
    } finally {
      await emit("session_shutdown", { reason: "quit" });
      fs.rmSync(scope, { recursive: true, force: true });
      fs.rmSync(configFile, { force: true });
      fs.rmSync(modelOnlyTemplateFile, { force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });
});

describe("completion mailbox", () => {
  test("waits until explicitly cancelled when no completion exists", async () => {
    const manager = new AgentManager();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled")), 10);
    await expect(manager.waitAgent("empty-parent", undefined, controller.signal)).rejects.toThrow("cancelled");
    await manager.shutdown();
  });

  test("consumes one matching completion without dropping siblings", () => {
    const events = [
      { id: "1", parentSessionId: "parent", agentName: "/one", status: "completed", createdAt: 1 },
      { id: "2", parentSessionId: "parent", agentName: "/two", status: "completed", createdAt: 2 },
      { id: "3", parentSessionId: "other", agentName: "/one", status: "completed", createdAt: 3 },
    ] as any[];
    expect(consumeFirstMatchingMailboxEvent(events, "parent")?.agentName).toBe("/one");
    expect(events.map((event) => event.id)).toEqual(["2", "3"]);
    expect(consumeFirstMatchingMailboxEvent(events, "parent", new Set(["/two"]))?.agentName).toBe("/two");
    expect(events.map((event) => event.id)).toEqual(["3"]);
  });
});

describe("observer broadcast", () => {
  let broadcaster: InstanceType<typeof EventBroadcaster>;
  let agentId: string;
  let events: any[];
  let sockets: net.Socket[];
  let overlays: InstanceType<typeof SubagentPeekOverlay>[];

  beforeEach(async () => {
    agentId = randomUUID();
    events = [];
    sockets = [];
    overlays = [];
    broadcaster = new EventBroadcaster(agentId);
    broadcaster.start();
    await once(broadcaster["server"]!, "listening");
    const socket = net.connect(getSocketPath(agentId));
    sockets.push(socket);
    const decoder = new RpcJsonlDecoder();
    socket.on("data", (chunk) => {
      for (const line of decoder.push(chunk)) events.push(JSON.parse(line));
    });
    let error: Error | undefined;
    socket.on("error", (value) => { error = value; });
    await waitUntil(() => {
      if (error) throw error;
      return events[0]?.type === "sync";
    });
    events.length = 0;
  });

  afterEach(async () => {
    const server = broadcaster["server"];
    const closed = server ? once(server, "close") : Promise.resolve();
    for (const overlay of overlays) overlay.dispose();
    for (const socket of sockets) socket.destroy();
    broadcaster.stop();
    await closed;
  });

  const start = (id: string, toolName = "codemode", args: any = { code: "script" }) => ({
    type: "tool_execution_start", toolCallId: id, toolName, args,
  });
  const update = (id: string, partialResult: any) => ({
    type: "tool_execution_update", toolCallId: id, toolName: "codemode", partialResult,
  });
  const end = (id: string, result: any, isError = false) => ({
    type: "tool_execution_end", toolCallId: id, toolName: "codemode", result, isError,
  });
  const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
  const messageEnd = (id: string) => ({
    type: "message_end", message: { role: "toolResult", toolCallId: id },
  });
  const emit = (...values: any[]) => {
    for (const value of values) broadcaster.broadcast(value);
  };
  const snapshot = async () => (await readSocketEvents(getSocketPath(agentId), 1))[0];
  const flush = async () => {
    const token = randomUUID();
    emit({ type: "test_barrier", token });
    await waitUntil(() => events.some((event) => event.type === "test_barrier" && event.token === token));
    return events.filter((event) => event.type !== "test_barrier");
  };
  const nested = (event: any, parentToolCallId: string) => ({ ...event, parentToolCallId });

  test("filters parallel nested notifications before state changes and preserves parent progress/results", async () => {
    const parent = start("parent");
    const partialResult = {
      ...textResult("script is running"),
      details: { calls: [{ id: "parent/1", name: "read", status: "running" }] },
    };
    const result = {
      ...textResult("caught child error; script succeeded"),
      details: { calls: [{ id: "parent/1", name: "read", status: "error", error: "missing file" }] },
    };
    emit(parent,
      nested(start("parent/1", "read"), "parent"),
      nested(start("parent/2", "powershell"), "parent"),
      nested(update("parent/1", textResult("child-only output")), "parent"),
      update("parent", partialResult));
    expect(await snapshot()).toMatchObject({
      status: "tool", toolName: "codemode",
      activeTools: [{ toolCallId: "parent", toolName: "codemode", args: parent.args, partialResult }],
    });

    emit(nested(end("parent/1", textResult("missing file"), true), "parent"),
      nested(end("parent/2", textResult("child-only output")), "parent"),
      end("parent", result));
    expect(await flush()).toEqual([parent, update("parent", partialResult), end("parent", result)]);
    expect((await snapshot()).activeTools).toEqual([{
      toolCallId: "parent", toolName: "codemode", args: parent.args, partialResult, result, isError: false,
    }]);
  });

  test("ignores orphaned and multi-level nested events even without a cached parent", async () => {
    const before = await snapshot();
    for (const parent of ["missing", "missing/child"]) {
      const id = `${parent}/child`;
      emit(nested(start(id, "codemode"), parent),
        nested(update(id, textResult("nested progress")), parent),
        nested(end(id, textResult("nested failure"), true), parent));
    }
    expect(await flush()).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  test("keeps genuine top-level read, powershell and MCP calls, including IDs with slashes", async () => {
    const expected: any[] = [];
    for (const [id, name] of [["top/read", "read"], ["top/shell", "powershell"], ["top/mcp", "mcp__docs"]]) {
      const values = [
        start(id, name, { input: name }),
        { ...update(id, textResult("progress")), toolName: name },
        { ...end(id, textResult("output")), toolName: name },
      ];
      emit(...values);
      expected.push(...values);
    }
    expect(await flush()).toEqual(expected);
    expect((await snapshot()).activeTools.map((tool: any) => [tool.toolCallId, tool.toolName]))
      .toEqual([["top/read", "read"], ["top/shell", "powershell"], ["top/mcp", "mcp__docs"]]);
  });

  test.each([
    { isError: false },
    { isError: true },
    { isError: false, durationMs: 84, resultDurationMs: 42, expectedDurationMs: 84 },
    { isError: true, resultDurationMs: 42, expectedDurationMs: 42 },
    { isError: false, durationMs: 0, resultDurationMs: 42, expectedDurationMs: 0 },
    { isError: true, resultDurationMs: 0, expectedDurationMs: 0 },
  ])("retains a finished parent's result until its toolResult message (%j)", async ({ isError, durationMs, resultDurationMs, expectedDurationMs }) => {
    const result = { ...textResult("final script output"), details: { calls: [], elapsed: 42 }, durationMs: resultDurationMs };
    const inputs = [start("parent"), { ...end("parent", result, isError), durationMs }] as const;
    const original = JSON.stringify(inputs);
    const cachedTool = {
      toolCallId: "parent", toolName: "codemode", args: inputs[0].args,
      result: { ...result, durationMs: expectedDurationMs }, isError,
    };
    emit(...inputs);
    expect((await snapshot()).activeTools).toEqual([cachedTool]);
    emit(messageEnd("unrelated"));
    expect((await snapshot()).activeTools).toEqual([cachedTool]);
    // message_end is the existing event handoff, not a disk-write acknowledgement.
    emit(messageEnd("parent"));
    expect((await snapshot()).activeTools).toEqual([]);
    expect(await flush()).toEqual([...inputs, messageEnd("unrelated"), messageEnd("parent")]);
    expect(JSON.stringify(inputs)).toBe(original);
  });

  test("updates and clears parallel top-level calls independently", async () => {
    emit(start("a"), start("b"),
      nested(start("a/1", "read"), "a"),
      nested(start("a/1/1", "powershell"), "a/1"),
      update("a", textResult("a progress")), end("a", textResult("a done")));
    expect((await snapshot()).activeTools.map((tool: any) => tool.toolCallId)).toEqual(["a", "b"]);
    emit(messageEnd("a"),
      nested(end("a/1", textResult("late child"), true), "a"),
      update("b", textResult("b progress")));
    expect((await snapshot()).activeTools).toEqual([{
      toolCallId: "b", toolName: "codemode", args: { code: "script" }, partialResult: textResult("b progress"),
    }]);
    emit(end("b", textResult("b done")), messageEnd("b"));
    expect((await snapshot()).activeTools).toEqual([]);
    expect((await flush()).filter((event) => event.parentToolCallId)).toEqual([]);
  });

  test("forwards non-execution lifecycle/RPC events even when they carry parent metadata", async () => {
    const values = [
      { type: "agent_start" },
      { type: "response", id: "rpc", success: false, error: "expected" },
      { type: "message_start", message: { role: "user", content: "task" } },
      { type: "message_end", message: { role: "toolResult", toolCallId: "unknown" } },
      { type: "agent_end", messages: [] },
      { type: "auto_retry_end", success: false, finalError: "retry failed" },
      { type: "agent_settled" },
    ].map((event) => ({ ...event, parentToolCallId: "metadata-only" }));
    emit(...values);
    expect(await flush()).toEqual(values);
    expect(await snapshot()).toMatchObject({ status: "done", activeTools: [] });
  });

  test("does not accumulate completed nested calls over 100 scripts in one unsettled run", async () => {
    for (let index = 0; index < 100; index++) {
      const id = `script-${index}`;
      emit(start(id));
      for (let child = 1; child <= 2; child++) {
        emit(nested(start(`${id}/${child}`, child === 1 ? "read" : "powershell"), id),
          nested(end(`${id}/${child}`, textResult("child output")), id));
      }
      emit(update(id, textResult("script progress")), end(id, textResult("script output")), messageEnd(id));
    }
    expect((await snapshot()).activeTools).toEqual([]);
    const live = await flush();
    for (const type of ["tool_execution_start", "tool_execution_update", "tool_execution_end", "message_end"]) {
      expect(live.filter((event) => event.type === type)).toHaveLength(100);
    }
    expect(live.some((event) => event.parentToolCallId)).toBe(false);
  });

  test.each(["aborted", "error"])("preserves failure/interruption and settled cleanup (%s)", async (stopReason) => {
    const values = [
      start("parent"),
      { ...end("parent", textResult("Operation failed"), true), durationMs: 42 },
      { type: "message_end", message: { role: "assistant", content: [], stopReason, errorMessage: "Operation failed" } },
      { type: "agent_end", messages: [] },
    ];
    emit(...values);
    expect((await snapshot()).activeTools).toEqual([{
      toolCallId: "parent", toolName: "codemode", args: { code: "script" },
      result: { ...textResult("Operation failed"), durationMs: 42 }, isError: true,
    }]);
    emit({ type: "agent_settled" },
      nested(start("late/child", "read"), "finished-parent"),
      nested(end("late/child", textResult("late nested failure"), true), "finished-parent"));
    expect(await flush()).toEqual([...values, { type: "agent_settled" }]);
    const sync = await snapshot();
    expect(sync).toMatchObject({ status: "done", activeTools: [], partialMessage: null, userMessage: null });
    expect(sync.toolName).toBeUndefined();
  });

  test("keeps raw nested RPC activity, completion delivery, response reads and waits in AgentManager", async () => {
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    const terminate = mock(async () => {});
    manager["terminateProcess"] = terminate;
    await manager.ready();
    const parentSessionId = `observer-${agentId}`;
    const scope = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.mkdirSync(scope, { recursive: true });
    const info: AgentInfo = {
      id: agentId, taskName: "observer", canonicalName: "/observer", parentSessionId,
      provider: "test", modelId: "fake", model: "test:fake", cwd: TEST_AGENT_DIR,
      sessionFile: path.join(scope, `${agentId}.jsonl`),
      infoFile: path.join(scope, `${agentId}.info.json`),
      logFile: path.join(scope, `${agentId}.log`),
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, status: "starting",
    };
    const live: any = {
      info, broadcaster, logger: { info() {} }, pending: new Map(),
      lastActivityPersistedAt: 0, finalizedRun: false, expectedExit: false,
    };
    const receive = (...values: any[]) => {
      const decoder = new RpcJsonlDecoder();
      const data = Buffer.from(values.map((event) => JSON.stringify(event) + "\n").join(""));
      for (const chunk of [data.subarray(0, 7), data.subarray(7)]) {
        for (const line of decoder.push(chunk)) manager["handleLine"](live, line);
      }
    };
    try {
      for (const event of [
        nested(start("parent/1", "read"), "parent"),
        nested(update("parent/1", textResult("nested progress")), "parent"),
        nested(end("parent/1", textResult("nested error"), true), "parent"),
      ]) {
        live.info.status = "starting";
        live.lastActivityPersistedAt = 0;
        receive(event);
        expect(JSON.parse(fs.readFileSync(info.infoFile, "utf8"))).toMatchObject({
          status: "running", lastActivity: live.info.lastActivity,
        });
      }
      expect(await flush()).toEqual([]);
      const resolve = mock(() => {});
      live.pending.set("rpc", { resolve, reject: mock(), timer: setTimeout(() => {}, 5000) });
      receive({ type: "response", id: "rpc", success: true, data: { ok: true }, parentToolCallId: "metadata" });
      expect(resolve).toHaveBeenCalledWith({ ok: true });
      expect(live.pending.size).toBe(0);

      receive({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final response" }], stopReason: "stop" } },
        { type: "agent_settled" });
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({ status: "completed", finalResponse: "final response" });
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(manager.readAgentResponse("observer", parentSessionId)).toMatchObject({
        status: "completed", finalResponse: "final response",
      });
      expect((await manager.waitAgent(parentSessionId, ["observer"])).event).toMatchObject({ status: "completed" });
      expect((await manager.waitAllAgents(parentSessionId, ["observer"])).responses)
        .toEqual([expect.objectContaining({ status: "completed", finalResponse: "final response" })]);
      expect((await snapshot()).activeTools).toEqual([]);
    } finally {
      for (const pending of live.pending.values()) clearTimeout(pending.timer);
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test.each(["regular", "fullscreen"] as const)("isolated native %s TUI handles live socket previews, input, reopen, resize and offline recovery", async (mode) => {
    codingAgent.initTheme("dark", false);
    const sessionDir = fs.mkdtempSync(path.join(TEST_AGENT_DIR, "tui-session-"));
    const session = codingAgent.SessionManager.create(TEST_AGENT_DIR, sessionDir);
    session.appendMessage({ role: "user", content: "isolated TUI task", timestamp: Date.now() });
    const args = { code: 'await Promise.allSettled([tools.read({ path: "中文.txt" })]);' };
    const assistant: any = {
      role: "assistant", content: [{ type: "toolCall", id: "tui-call", name: "codemode", arguments: args }],
      api: "test", provider: "test", model: "fake", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    session.appendMessage(assistant);
    const partial = { ...textResult("hidden partial text"), details: { calls: [
      { name: "nested/read", args: "path=中文.txt", status: "running" },
    ] } };
    emit(start("tui-call", "codemode", args), update("tui-call", partial));
    const info = { id: agentId, taskName: "isolated TUI", provider: "test", modelId: "fake",
      cwd: TEST_AGENT_DIR, sessionFile: session.getSessionFile()! } as AgentInfo;
    let input: (data: string) => void = () => {};
    let resize = () => {};
    const writes: string[] = [];
    const terminal: Terminal & { columns: number; rows: number } = {
      columns: 120, rows: 35, kittyProtocolActive: false,
      start(onInput, onResize) { input = onInput; resize = onResize; },
      stop() {}, async drainInput() {}, write(data) { writes.push(data); },
      moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
      clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const navigation: Array<"previous" | "next" | undefined> = [];
    let overlay: InstanceType<typeof SubagentPeekOverlay>;
    let hide = () => {};
    const mount = async () => {
      overlay = new SubagentPeekOverlay(tui, { fg: (_color: string, text: string) => text } as any,
        info, (value) => { navigation.push(value); hide(); }, nativeCodemodeRenderers, { outputPad: 0, showImages: false });
      overlays.push(overlay);
      const socket = overlay["socket"]!;
      await once(socket, "data"); // genuine sync arrives over the isolated socket/named pipe
      const handle = tui.showOverlay(overlay, { anchor: "right-center", width: "80%", minWidth: 38, maxHeight: 31 });
      hide = () => { overlay.dispose(); handle.hide(); };
      writes.length = 0;
      tui.renderNow(true);
    };
    const tool = () => overlay!["chatContainer"].children.find(
      (child) => child instanceof codingAgent.ToolExecutionComponent,
    ) as ToolExecutionComponent;
    const output = () => stripVTControlCharacters(writes.join(""));
    const draw = () => {
      writes.length = 0;
      tui.renderNow(true);
      return output();
    };
    tui.start();
    try {
      await mount();
      expect(output()).toContain("… nested/read");
      expect(tool()["expanded"]).toBe(false);
      expect(tool()["executionStarted"]).toBe(true);
      input("\x0f"); // Ctrl+O stays inside the overlay, not the main tools-expand action.
      if (mode === "fullscreen") {
        input("\x1b[<0;70;15M");
        input("\x1b[<0;70;15m");
      }
      expect(tool()["expanded"]).toBe(false);
      for (const key of ["k", "j", "g", "G"]) input(key);
      terminal.columns = 55;
      resize();
      expect(draw()).toContain("nested/read");
      terminal.columns = 120;
      resize();
      overlay!.invalidate();
      expect(draw()).toContain("… nested/read");
      expect(tool()["expanded"]).toBe(false);
      input("q");
      expect(overlay!["disposed"]).toBe(true);
      await mount();
      expect(output()).toContain("… nested/read");
      expect(tool()["executionStarted"]).toBe(true);

      const result = { ...textResult("tui_final_output"), details: { calls: [
        { name: "nested/read", args: "path=中文.txt", status: "error", error: "caught failure", durationMs: 15 },
      ] } };
      const original = structuredClone(result);
      emit({ ...end("tui-call", result), durationMs: 2600 });
      await waitUntil(() => !overlay!["pendingTools"].has("tui-call"));
      draw();
      expect(output()).toContain("✗ nested/read");
      expect(output()).toContain("tui_final_output");
      expect(output()).toContain("Took 2.6s");
      expect(tool()["result"]!.isError).toBe(false);
      expect(result).toEqual(original);
      const finalMessage: any = { role: "toolResult", toolCallId: "tui-call", toolName: "codemode",
        ...result, durationMs: 2600, isError: false, timestamp: Date.now() };
      emit({ type: "message_end", message: finalMessage });
      session.appendMessage(finalMessage);
      emit({ type: "agent_settled" });
      await waitUntil(() => overlay!["status"] === "done");
      input("\x1b[D");
      expect(overlay!["disposed"]).toBe(true);
      await mount();
      expect(output()).toContain("tui_final_output");
      expect(tool()["executionStarted"]).toBe(false); // history must not invent a fresh clock
      expect(tool()["expanded"]).toBe(false);
      input("\x1b[C");
      await mount();
      expect(output()).toContain("tui_final_output");
      expect(tool()["expanded"]).toBe(false);
      expect(navigation).toEqual([undefined, "previous", "next"]);

      const closed = once(broadcaster["server"]!, "close");
      broadcaster.stop();
      await closed;
      await waitUntil(() => overlay!["socket"] === null);
      session.appendMessage({ role: "user", content: "offline TUI file update", timestamp: Date.now() });
      overlay!["poll"]();
      overlay!.handleInput("G");
      draw();
      expect(output()).toContain("offline TUI file update");
      expect(codingAgent.SessionManager.open(info.sessionFile).buildSessionContext().messages
        .find((message) => message.role === "toolResult")).toMatchObject(finalMessage);
      input("q");
    } finally {
      hide();
      tui.stop();
    }
  });

  test("defers file rebuilds only for executing rows and resumes deferred or disconnected file recovery", async () => {
    codingAgent.initTheme("dark", false);
    const sessionDir = fs.mkdtempSync(path.join(TEST_AGENT_DIR, "poll-session-"));
    const session = codingAgent.SessionManager.create(TEST_AGENT_DIR, sessionDir);
    session.appendMessage({ role: "user", content: "isolated polling task", timestamp: Date.now() });
    const calls = ["file-only", "a", "c"].map((id) => ({
      type: "toolCall" as const, id, name: "custom_tool", arguments: { task: id },
    }));
    const assistant: any = {
      role: "assistant", content: calls, api: "test", provider: "test", model: "fake",
      stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    session.appendMessage(assistant);
    emit(start("a", "custom_tool", calls[1].arguments), start("c", "custom_tool", calls[2].arguments));
    const info = { id: agentId, taskName: "polling", provider: "test", modelId: "fake",
      cwd: TEST_AGENT_DIR, sessionFile: session.getSessionFile()! } as AgentInfo;
    const overlay = new SubagentPeekOverlay({ terminal: { rows: 80 }, requestRender() {} } as any,
      { fg: (_color: string, text: string) => text } as any, info, () => {}, nativeCodemodeRenderers);
    overlays.push(overlay);
    await waitUntil(() => overlay["pendingTools"].get("c")?.executing === true);
    const a = overlay["pendingTools"].get("a")!.component;
    const c = overlay["pendingTools"].get("c")!.component;
    expect(overlay["pendingTools"].get("file-only")!.executing).toBe(false);
    const persistedResult = (id: string, text: string) => ({
      role: "toolResult" as const, toolCallId: id, toolName: "custom_tool", ...textResult(text),
      isError: false, durationMs: 100, timestamp: Date.now(),
    });

    // A stale historical row is still pending, but its file result arrives while real calls run.
    session.appendMessage(persistedResult("file-only", "file_only_result"));
    overlay["poll"]();
    expect(overlay["historyDirty"]).toBe(true);
    expect(overlay["pendingTools"].get("a")!.component).toBe(a);
    expect(overlay["pendingTools"].get("c")!.component).toBe(c);
    emit(end("a", textResult("a result")));
    await waitUntil(() => !overlay["pendingTools"].has("a"));
    overlay["poll"]();
    expect(overlay["pendingTools"].get("c")!.component).toBe(c);
    session.appendMessage(persistedResult("a", "a result"));
    overlay["poll"]();
    const deferredSize = overlay["lastFileSize"];
    emit(end("c", textResult("c result")));
    await waitUntil(() => !overlay["pendingTools"].has("c"));
    overlay["poll"]();
    expect(overlay["lastFileSize"]).toBe(deferredSize); // no later file growth was needed
    expect(overlay["historyDirty"]).toBe(false);
    expect(overlay["pendingTools"].has("file-only")).toBe(false);
    expect(stripVTControlCharacters(overlay.render(120).join("\n"))).toContain("file_only_result");

    // A reconnected execution reuses the unresolved historical row; disconnect permits file fallback.
    emit(start("c", "custom_tool", calls[2].arguments));
    await waitUntil(() => overlay["pendingTools"].get("c")?.executing === true);
    session.appendMessage(persistedResult("c", "disconnected_file_result"));
    overlay["socket"]!.destroy();
    await waitUntil(() => overlay["socket"] === null && !overlay["pendingTools"].has("c"));
    expect(stripVTControlCharacters(overlay.render(120).join("\n"))).toContain("disconnected_file_result");
    session.appendMessage({ role: "user", content: "offline_file_tail", timestamp: Date.now() });
    overlay["poll"]();
    expect(stripVTControlCharacters(overlay.render(120).join("\n"))).toContain("offline_file_tail");
  });

  test("renders live, reconnect and persisted history with the same top-level ownership", async () => {
    codingAgent.initTheme("dark", false);
    const sessionDir = fs.mkdtempSync(path.join(TEST_AGENT_DIR, "observer-session-"));
    const session = codingAgent.SessionManager.create(TEST_AGENT_DIR, sessionDir);
    session.appendMessage({ role: "user", content: "isolated observer task", timestamp: Date.now() });
    const info = {
      id: agentId, taskName: "observer", provider: "test", modelId: "fake", model: "test:fake",
      cwd: TEST_AGENT_DIR, sessionFile: session.getSessionFile()!,
    } as AgentInfo;
    const navigation: Array<"previous" | "next" | undefined> = [];
    const open = async (expectSync = true) => {
      const overlay = new SubagentPeekOverlay({
        terminal: { rows: 80 }, requestRender() {},
      } as any, { fg: (_color: string, text: string) => text } as any, info, (value) => navigation.push(value), nativeCodemodeRenderers);
      overlays.push(overlay);
      const socket = overlay["socket"]!;
      sockets.push(socket);
      const decoder = new RpcJsonlDecoder();
      let synced = false;
      const onData = (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) {
          if (JSON.parse(line).type === "sync") synced = true;
        }
      };
      socket.on("data", onData);
      try {
        await waitUntil(() => expectSync ? synced : overlay["socket"] === null);
      } finally {
        socket.off("data", onData);
      }
      return overlay;
    };
    const tools = (overlay: InstanceType<typeof SubagentPeekOverlay>) =>
      overlay["chatContainer"].children.filter((child) => child instanceof codingAgent.ToolExecutionComponent);
    const render = (overlay: InstanceType<typeof SubagentPeekOverlay>) =>
      stripVTControlCharacters(overlay.render(120).join("\n"));
    let overlay = await open();
    const parent = start("script", "codemode", { code: 'await Promise.all([tools.read({path: "nested.txt"}), tools.powershell({command: "echo nested"})])' });
    const assistant: any = {
      role: "assistant", content: [{ type: "toolCall", id: "script", name: "codemode", arguments: parent.args }],
      api: "test", provider: "test", model: "fake", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    emit({ type: "message_start", message: { ...assistant, content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "script", toolName: "codemode" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(parent.args) } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: assistant.content[0] } },
      { type: "message_end", message: assistant });
    session.appendMessage(assistant);
    emit(parent,
      nested(start("script/1", "read", { path: "nested.txt" }), "script"),
      nested(start("script/2", "powershell", { command: "echo nested" }), "script"),
      update("script", { ...textResult("parent progress"), details: { calls: [
        { name: "nested/read", args: "path=nested.txt", status: "running" },
      ] } }));
    await waitUntil(() => render(overlay).includes("… nested/read"));
    expect(tools(overlay)).toHaveLength(1);
    expect(overlay["pendingTools"].has("script/1")).toBe(false);
    expect(overlay["pendingTools"].has("script/2")).toBe(false);

    overlay.dispose();
    overlay = await open();
    expect(tools(overlay)).toHaveLength(1);
    expect(render(overlay)).toContain("… nested/read");
    expect(render(overlay)).not.toContain("parent progress");
    const result = { ...textResult("final script output"), durationMs: 1234, details: { calls: [
      { name: "nested/read", args: "path=nested.txt", status: "ok", durationMs: 12 },
      { name: "nested/powershell", args: "command=echo nested", status: "error", durationMs: 23, error: "caught error" },
      { name: "nested/cancelled", args: "", status: "cancelled" },
    ] } };
    emit(nested(end("script/1", textResult("nested file")), "script"),
      nested(end("script/2", textResult("nested shell")), "script"),
      end("script", result));
    await waitUntil(() => render(overlay).includes("final script output"));
    overlay.dispose();
    overlay = await open();
    expect(tools(overlay)).toHaveLength(1);
    expect(render(overlay)).toContain("final script output");
    expect(render(overlay)).toContain("✓ nested/read");
    expect(render(overlay)).toContain("✗ nested/powershell");
    expect(render(overlay)).toContain("⊘ nested/cancelled");
    expect(render(overlay)).toContain("Took 1.2s");
    const reference = new codingAgent.ToolExecutionComponent("codemode", "script", parent.args, {},
      nativeCodemodeRenderers, { requestRender() {} } as any, TEST_AGENT_DIR);
    reference.setExpanded(false);
    reference.setArgsComplete();
    reference.updateResult({ ...result, isError: false }, false);
    expect(tools(overlay)[0].render(118)).toEqual(reference.render(118));

    const toolResult: any = { role: "toolResult", toolCallId: "script", toolName: "codemode", ...result, isError: false, timestamp: Date.now() };
    emit({ type: "message_end", message: toolResult });
    // Observe the event/file gap without treating message_end as a disk acknowledgement.
    await flush();
    expect(codingAgent.SessionManager.open(info.sessionFile).buildSessionContext().messages
      .some((message) => message.role === "toolResult")).toBe(false);
    overlay.dispose();
    overlay = await open();
    expect(tools(overlay)).toHaveLength(1);
    expect(render(overlay)).not.toContain("final script output");
    session.appendMessage(toolResult);
    await waitUntil(() => render(overlay).includes("final script output"));
    const direct = start("direct/read", "read", { path: "real-top-level.txt" });
    const directAssistant = { ...assistant, content: [{ type: "toolCall", id: direct.toolCallId, name: "read", arguments: direct.args }] };
    session.appendMessage(directAssistant);
    emit(direct, { ...end(direct.toolCallId, textResult("top-level file")), toolName: "read" });
    const directResult: any = { role: "toolResult", toolCallId: direct.toolCallId, toolName: "read",
      ...textResult("top-level file"), isError: false, timestamp: Date.now() };
    emit({ type: "message_end", message: directResult });
    session.appendMessage(directResult);
    await waitUntil(() => render(overlay).includes("real-top-level.txt"));
    expect(tools(overlay)).toHaveLength(2);
    emit({ type: "agent_settled" });
    await waitUntil(() => overlay["status"] === "done");
    expect(render(overlay)).toContain("final script output");
    expect(render(overlay)).toContain("real-top-level.txt");
    expect(tools(overlay)).toHaveLength(2);

    overlay.dispose();
    overlay = await open();
    expect(tools(overlay)).toHaveLength(2);
    expect(render(overlay)).toContain("final script output");
    expect(render(overlay)).toContain("real-top-level.txt");
    for (const key of ["k", "j", "g", "G"]) expect(() => overlay.handleInput(key)).not.toThrow();
    overlay.handleInput("\x1b[D");
    overlay = await open();
    overlay.handleInput("\x1b[C");
    overlay = await open();
    overlay.handleInput("q");
    expect(navigation).toEqual(["previous", "next", undefined]);
    const closed = once(broadcaster["server"]!, "close");
    broadcaster.stop();
    await closed;
    overlay = await open(false);
    expect(tools(overlay)).toHaveLength(2);
    expect(render(overlay)).toContain("final script output");
    expect(render(overlay)).toContain("real-top-level.txt");
    expect(codingAgent.SessionManager.open(info.sessionFile).buildSessionContext().messages
      .filter((message) => message.role === "toolResult").map((message: any) => message.toolCallId))
      .toEqual(["script", "direct/read"]);
  });
});

describe("context usage formatting", () => {
  test.each([
    [50000, 500000, 10, "10%/500k"],
    [60000, 500000, 12, "12%/500k"],
    [1, 500000, 10.44, "10.4%/500k"],
    [0, 500000, 0, "0%/500k"],
    [1, 500000, 0.0002, "<0.1%/500k"],
    [500, 500000, 0.1, "0.1%/500k"],
    [525000, 500000, 105, "105%/500k"],
    [null, 500000, null, "?%/500k"],
    [105000, 1050000, 10, "10%/1.05M"],
    [100000, 1000000, 10, "10%/1M"],
    [1, 1000, 1, "1%/1k"],
    [1, 999, 1, "1%/999"],
  ])("formats native values %s/%s (%s)", (tokens, contextWindow, percent, expected) => {
    expect(formatContextUsage({ tokens, contextWindow, percent })).toBe(expected);
  });

  test.each([undefined, null, false, 0, [], {}, { contextWindow: 0 }, { contextWindow: -1 },
    { contextWindow: NaN }, { contextWindow: Infinity }, { contextWindow: "500000" },
  ].map((value) => ({ value })))("rejects an unknown or invalid context window %#", ({ value }) => {
    expect(normalizeContextUsage(value)).toBeUndefined();
    expect(formatContextUsage(value)).toBe("?%/?");
  });

  test.each([
    {}, { tokens: 0 }, { percent: 0 }, { tokens: null, percent: 0 }, { tokens: 1, percent: null },
    { tokens: -1, percent: 10 }, { tokens: 1, percent: -10 }, { tokens: NaN, percent: 10 },
    { tokens: 1, percent: Infinity }, { tokens: "1", percent: "10" },
  ])("normalizes an incomplete or invalid usage pair to unknown %#", (value) => {
    const input = { contextWindow: 500000, ...value };
    expect(normalizeContextUsage(input)).toEqual({ contextWindow: 500000, tokens: null, percent: null });
    expect(formatContextUsage(input)).toBe("?%/500k");
  });

  test("validates disk snapshots without migrating legacy history", () => {
    const directory = fs.mkdtempSync(path.join(TEST_AGENT_DIR, "context-read-"));
    const file = path.join(directory, "agent.info.json");
    try {
      for (const value of [
        { status: "completed" },
        { status: "completed", contextUsage: { contextWindow: 0, tokens: 0, percent: 0 } },
        { status: "completed", contextUsage: "bad metadata" },
      ]) {
        fs.writeFileSync(file, JSON.stringify(value));
        expect(readInfoFile(file)?.contextUsage).toBeUndefined();
      }
      fs.writeFileSync(file, '{"status":"completed","contextUsage":{"contextWindow":500000,"tokens":-1,"percent":10}}');
      expect(formatContextUsage(readInfoFile(file)?.contextUsage)).toBe("?%/500k");
      fs.writeFileSync(file, "null");
      expect(readInfoFile(file)).toBeUndefined();
      fs.writeFileSync(file, "{");
      expect(readInfoFile(file)).toBeUndefined();
      fs.rmSync(file);
      expect(readInfoFile(file)).toBeUndefined();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("context usage sampling", () => {
  const initialUsage = { tokens: 50000, contextWindow: 500000, percent: 10 };
  const nextUsage = { tokens: 60000, contextWindow: 500000, percent: 12 };
  let manager: InstanceType<typeof AgentManager>;
  let info: AgentInfo;
  let live: any;
  let commands: any[];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const emit = (event: any) => manager["handleLine"](live, JSON.stringify(event));
  const reply = (command: any, data: any, success = true) => emit({
    type: "response", id: command.id, success, data, error: success ? undefined : "statistics unavailable",
  });
  const refresh = () => manager["requestContextRefresh"](live);

  beforeEach(async () => {
    manager = new AgentManager();
    await manager.ready();
    const parentSessionId = `context-unit-${randomUUID()}`;
    const directory = path.join(getRunsDir(), parentScopeKey(parentSessionId));
    fs.mkdirSync(directory, { recursive: true });
    const id = randomUUID();
    info = {
      id, taskName: "worker", canonicalName: "/worker", parentSessionId,
      provider: "test", modelId: "fake", model: "test:fake", cwd: TEST_AGENT_DIR,
      infoFile: path.join(directory, `${id}.info.json`),
      sessionFile: path.join(directory, `${id}.jsonl`), logFile: path.join(directory, `${id}.log`),
      createdAt: 1, updatedAt: 1, lastActivity: 1, messageCount: 1, status: "running",
      contextUsage: { ...initialUsage },
      childProcess: { pid: -1, processIdentity: "fixture", token: randomUUID(), ownerPid: process.pid, startedAt: 1 },
    };
    fs.writeFileSync(info.infoFile, JSON.stringify(info));
    commands = [];
    let resolveExit!: () => void;
    live = {
      info, proc: { stdin: {
        write(payload: string, callback: (error?: Error) => void) { commands.push(JSON.parse(payload)); callback(); },
        end() { live.processFinished = true; resolveExit(); },
      } },
      pending: new Map(), reqId: 0, stderr: "", expectedExit: false, processFinished: false,
      finalizedRun: false, awaitingPrompt: false, candidateResponse: "", lastActivityPersistedAt: 1,
      contextEpoch: 0, contextRefreshDirty: false, logger: { info: mock(() => {}) },
      broadcaster: { broadcast: mock(() => {}) },
      exitPromise: new Promise<void>((resolve) => { resolveExit = resolve; }),
    };
    manager["live"].set(info.id, live);
  });

  afterEach(async () => {
    live.processFinished = true;
    for (const pending of live.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("fixture disposed"));
    }
    live.pending.clear();
    await live.contextRefresh;
    manager["live"].delete(info.id);
    await manager.shutdown();
    fs.rmSync(path.dirname(info.infoFile), { recursive: true, force: true });
  });

  test("samples only native current usage and leaves lifecycle and activity untouched", async () => {
    refresh();
    expect(commands.map((command) => command.type)).toEqual(["get_session_stats"]);
    reply(commands[0], { tokens: { total: 110000, cacheRead: 90000 }, contextUsage: nextUsage });
    await live.contextRefresh;
    const saved = readInfoFile(info.infoFile)!;
    expect(saved.contextUsage).toEqual(nextUsage);
    expect(formatContextUsage(saved.contextUsage)).toBe("12%/500k");
    expect(saved).toMatchObject({ status: "running", lastActivity: 1, messageCount: 1, childProcess: info.childProcess });
    expect(live.info.contextUsage).toEqual(nextUsage);
    expect(live.contextRefresh).toBeUndefined();
    const updatedAt = saved.updatedAt;
    refresh();
    reply(commands[1], { contextUsage: nextUsage });
    await live.contextRefresh;
    expect(readInfoFile(info.infoFile)?.updatedAt).toBe(updatedAt);
  });

  test("coalesces message and turn bursts into one in-flight request and one follow-up", async () => {
    for (const role of ["user", "assistant", "toolResult", "system", "custom"]) {
      emit({ type: "message_end", message: { role, content: [] } });
    }
    emit({ type: "turn_end" });
    emit({ type: "entry_appended", entry: { type: "message" } });
    emit({ type: "entry_appended", entry: { type: "custom_message" } });
    expect(commands).toHaveLength(1);
    expect(live.pending.size).toBe(1);
    reply(commands[0], { contextUsage: nextUsage });
    await tick();
    expect(commands).toHaveLength(2);
    expect(live.pending.size).toBe(1);
    reply(commands[1], { contextUsage: nextUsage });
    await live.contextRefresh;
    const updatedAt = readInfoFile(info.infoFile)?.updatedAt;
    live.lastActivityPersistedAt = Date.now();
    for (let index = 0; index < 50; index++) {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
      emit({ type: "tool_execution_update" });
      emit({ type: "queue_update" });
      emit({ type: "entry_appended", entry: { type: "custom" } });
    }
    expect(commands).toHaveLength(2);
    expect(readInfoFile(info.infoFile)?.updatedAt).toBe(updatedAt);
  });

  test("distinguishes rejected, timed-out, missing and valid unknown statistics", async () => {
    refresh();
    reply(commands[0], undefined, false);
    await live.contextRefresh;
    expect(readInfoFile(info.infoFile)?.contextUsage).toEqual(initialUsage);
    refresh();
    await live.contextRefresh; // Real sendCommand timeout, no automatic retry.
    expect(commands).toHaveLength(2);
    expect(readInfoFile(info.infoFile)?.contextUsage).toEqual(initialUsage);
    await tick();
    expect(commands).toHaveLength(2);
    refresh();
    reply(commands[2], { tokens: { total: 1000000 } });
    await live.contextRefresh;
    expect(readInfoFile(info.infoFile)?.contextUsage).toBeUndefined();
    expect(live.info.contextUsage).toBeUndefined();
    refresh();
    reply(commands[3], { contextUsage: { tokens: null, percent: null, contextWindow: 500000 } });
    await live.contextRefresh;
    expect(formatContextUsage(readInfoFile(info.infoFile)?.contextUsage)).toBe("?%/500k");
    expect(readInfoFile(info.infoFile)?.status).toBe("running");
    expect(manager["mailbox"]).toHaveLength(0);
  });

  test.each([
    { type: "compaction_end", result: { summary: "success" } },
    { type: "entry_appended", entry: { type: "context_edit" } },
    { type: "entry_appended", entry: { type: "compaction" } },
  ])("invalidates known usage before a late pre-edit response %#", async (event) => {
    refresh();
    emit(event);
    expect(live.contextEpoch).toBe(1);
    expect(formatContextUsage(readInfoFile(info.infoFile)?.contextUsage)).toBe("?%/500k");
    reply(commands[0], { contextUsage: { ...initialUsage, percent: 95 } });
    await tick();
    expect(commands).toHaveLength(2);
    expect(formatContextUsage(readInfoFile(info.infoFile)?.contextUsage)).toBe("?%/500k");
    reply(commands[1], undefined, false);
    await live.contextRefresh;
    expect(formatContextUsage(readInfoFile(info.infoFile)?.contextUsage)).toBe("?%/500k");
    expect(readInfoFile(info.infoFile)?.lastActivity).toBe(1);
  });

  test("failed or canceled compaction does not invalidate or sample", () => {
    emit({ type: "compaction_end", aborted: true });
    emit({ type: "compaction_end", errorMessage: "failed" });
    emit({ type: "compaction_start", reason: "threshold" });
    expect(live.contextEpoch).toBe(0);
    expect(commands).toHaveLength(0);
    expect(readInfoFile(info.infoFile)?.contextUsage).toEqual(initialUsage);
  });

  test("all lifecycle gates stop both starting and saving background queries", async () => {
    for (const flag of ["awaitingPrompt", "finalizedRun", "expectedExit", "processFinished"]) {
      live[flag] = true;
      const count = commands.length;
      refresh();
      expect(commands).toHaveLength(count);
      live[flag] = false;
      refresh();
      live[flag] = true;
      reply(commands.at(-1), { contextUsage: nextUsage });
      await live.contextRefresh;
      expect(readInfoFile(info.infoFile)?.contextUsage).toEqual(initialUsage);
      live[flag] = false;
    }
    const owner = live.info.childProcess;
    delete live.info.childProcess;
    const count = commands.length;
    refresh();
    expect(commands).toHaveLength(count);
    live.info.childProcess = owner;
  });

  test("late callbacks cannot recreate metadata, replace ownership or write from an old instance", async () => {
    const original = fs.readFileSync(info.infoFile, "utf8");
    for (const mode of ["deleted", "owner-cleared", "owner-replaced", "instance-replaced"]) {
      fs.writeFileSync(info.infoFile, original);
      refresh();
      if (mode === "deleted") fs.rmSync(info.infoFile);
      else if (mode === "instance-replaced") manager["live"].set(info.id, { ...live });
      else {
        const persisted = JSON.parse(original);
        if (mode === "owner-cleared") delete persisted.childProcess;
        else persisted.childProcess.token = "new-owner";
        fs.writeFileSync(info.infoFile, JSON.stringify(persisted));
      }
      const before = fs.existsSync(info.infoFile) ? fs.readFileSync(info.infoFile, "utf8") : undefined;
      reply(commands.at(-1), { contextUsage: nextUsage });
      await live.contextRefresh;
      expect(fs.existsSync(info.infoFile) ? fs.readFileSync(info.infoFile, "utf8") : undefined).toBe(before);
      manager["live"].set(info.id, live);
    }
  });

  test("merges with current persisted lifecycle but never copies it back into live state", async () => {
    refresh();
    const persisted = { ...info, status: "completed", finalResponse: "preserve", completedAt: 123, lastActivity: 123 };
    fs.writeFileSync(info.infoFile, JSON.stringify(persisted));
    reply(commands[0], { contextUsage: nextUsage });
    await live.contextRefresh;
    expect(readInfoFile(info.infoFile)).toMatchObject({
      status: "completed", finalResponse: "preserve", completedAt: 123, lastActivity: 123,
      childProcess: persisted.childProcess, contextUsage: nextUsage,
    });
    expect(live.info.status).toBe("running");
    expect(live.info.lastActivity).toBe(1);
    emit({ type: "turn_end" });
    expect(live.finalizedRun).toBe(true);
    expect(commands).toHaveLength(1);
  });

  test("retries an identical sample after an atomic write failure without advancing memory", async () => {
    const temporary = `${info.infoFile}.${process.pid}.tmp`;
    fs.mkdirSync(temporary);
    live.logger.info = mock(() => { throw new Error("log storage also unavailable"); });
    refresh();
    reply(commands[0], { contextUsage: nextUsage });
    await live.contextRefresh;
    expect(readInfoFile(info.infoFile)?.contextUsage).toEqual(initialUsage);
    expect(live.info.contextUsage).toEqual(initialUsage);
    expect(live.logger.info).toHaveBeenCalledTimes(1);
    fs.rmSync(temporary, { recursive: true });
    emit({ type: "turn_end" });
    reply(commands[1], { contextUsage: nextUsage });
    await live.contextRefresh;
    expect(readInfoFile(info.infoFile)?.contextUsage).toEqual(nextUsage);
  });

  test("online steer saves the canonical live object after sampling during its await", async () => {
    const delivery = manager.sendMessage(info.parentSessionId, "worker", "new direction");
    await tick();
    expect(commands[0].type).toBe("steer");
    emit({ type: "turn_end" });
    reply(commands[1], { contextUsage: nextUsage });
    await live.contextRefresh;
    reply(commands[0], {});
    expect(await delivery).toEqual({ delivery: "steer" });
    expect(readInfoFile(info.infoFile)).toMatchObject({
      contextUsage: nextUsage, status: "running", childProcess: info.childProcess, lastTaskMessage: "new direction",
    });
  });

  test("online controls keep their original persisted-status decisions when another manager has interrupted the run", async () => {
    fs.writeFileSync(info.infoFile, JSON.stringify({ ...info, status: "interrupted" }));
    expect(await manager.interruptAgent(info.parentSessionId, "worker")).toEqual({ previous_status: "interrupted" });
    expect(commands).toHaveLength(0);
    expect(manager["mailbox"]).toHaveLength(0);
    const delivery = manager.sendMessage(info.parentSessionId, "worker", "resume");
    await tick();
    expect(commands.map((command) => command.type)).toEqual(["prompt"]);
    reply(commands[0], {});
    expect(await delivery).toEqual({ delivery: "prompt" });
    expect(commands[1].type).toBe("get_session_stats");
    reply(commands[1], { contextUsage: nextUsage });
    await live.contextRefresh;
    expect(readInfoFile(info.infoFile)).toMatchObject({ status: "running", contextUsage: nextUsage });
  });

  test("settlement delivers completion before final sampling, and old background results cannot overwrite it", async () => {
    refresh();
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    emit({ type: "agent_settled" });
    expect(commands.map((command) => command.type)).toEqual(["get_session_stats", "abort", "get_session_stats"]);
    expect(live.expectedExit).toBe(true);
    expect(live.termination).toBeInstanceOf(Promise);
    expect(readInfoFile(info.infoFile)).toMatchObject({ status: "completed", finalResponse: "done" });
    expect((await manager.waitAgent(info.parentSessionId, ["worker"])).event?.finalResponse).toBe("done");
    // Both management responses are decoded from a single data block.
    const decoder = new RpcJsonlDecoder();
    const records = [
      { type: "response", id: commands[2].id, success: true, data: { contextUsage: nextUsage } },
      { type: "response", id: commands[0].id, success: true, data: { contextUsage: initialUsage } },
      { type: "response", id: commands[1].id, success: true, data: {} },
    ];
    for (const line of decoder.push(Buffer.from(records.map((record) => JSON.stringify(record) + "\n").join("")))) {
      manager["handleLine"](live, line);
    }
    await live.termination;
    await live.contextRefresh;
    expect(readInfoFile(info.infoFile)).toMatchObject({ status: "completed", finalResponse: "done", contextUsage: nextUsage });
    expect(live.contextRefreshDirty).toBe(false);
  });

  test("final sampling keeps its original token even if a late event adopts another owner's final record", async () => {
    emit({ type: "agent_settled" });
    const replacement = {
      ...readInfoFile(info.infoFile)!, status: "failed", error: "replacement run",
      contextUsage: nextUsage, childProcess: { ...info.childProcess!, token: "replacement-token" },
    };
    fs.writeFileSync(info.infoFile, JSON.stringify(replacement));
    emit({ type: "turn_end" });
    expect(live.info.childProcess?.token).toBe("replacement-token");
    const before = fs.readFileSync(info.infoFile, "utf8");
    reply(commands[1], { contextUsage: { ...initialUsage, percent: 90 } });
    reply(commands[0], {});
    await live.termination;
    expect(fs.readFileSync(info.infoFile, "utf8")).toBe(before);
  });

  test("a timed-out final query retains the snapshot and continues termination", async () => {
    emit({ type: "agent_settled" });
    expect(manager["mailbox"]).toHaveLength(1);
    reply(commands[0], {});
    await live.termination;
    expect(live.processFinished).toBe(true);
    expect(live.pending.size).toBe(0);
    expect(readInfoFile(info.infoFile)?.contextUsage).toEqual(initialUsage);
    expect(manager["mailbox"]).toHaveLength(1);
  });

  test("a failed final sample cannot prevent SIGTERM/forced-kill escalation", async () => {
    const escalation: string[] = [];
    live.proc.stdin.end = mock(() => {});
    manager["signalProcessTree"] = (_live, signal) => {
      escalation.push(signal);
      if (signal === "SIGKILL") {
        live.processFinished = true;
        live.exitPromise = Promise.resolve();
      }
    };
    manager["forceKillWindowsTree"] = async () => {
      escalation.push("windows-kill");
      live.processFinished = true;
      live.exitPromise = Promise.resolve();
    };
    emit({ type: "agent_settled" });
    reply(commands[0], {});
    reply(commands[1], {}, false);
    await live.termination;
    expect(escalation).toEqual(["SIGTERM", process.platform === "win32" ? "windows-kill" : "SIGKILL"]);
    expect(live.proc.stdin.end).toHaveBeenCalledTimes(1);
    expect(readInfoFile(info.infoFile)).toMatchObject({ status: "completed", contextUsage: initialUsage });
    expect(manager["mailbox"]).toHaveLength(1);
  });

  test.each(["interrupt", "shutdown"])("forced %s does not request final statistics", async (action) => {
    const ending = action === "interrupt" ? manager.interruptAgent(info.parentSessionId, "worker") : manager.shutdown();
    await tick();
    expect(commands.map((command) => command.type)).toEqual(["abort"]);
    expect(readInfoFile(info.infoFile)).toMatchObject({ status: "interrupted", contextUsage: initialUsage });
    reply(commands[0], {});
    await ending;
  });

  test("prompt rejection preserves the previous final snapshot and never triggers acceptance sampling", async () => {
    live.info.status = "completed";
    live.info.finalResponse = "previous";
    live.info.completedAt = 99;
    const rejected = manager["prompt"](live, "reject", "reject").then(() => undefined, (error) => error);
    expect(commands.map((command) => command.type)).toEqual(["prompt"]);
    reply(commands[0], {}, false);
    expect(await rejected).toBeInstanceOf(Error);
    expect(readInfoFile(info.infoFile)).toMatchObject({ status: "completed", finalResponse: "previous", contextUsage: initialUsage });
    expect(commands).toHaveLength(1);
  });
});

describe("context usage RPC integration", () => {
  let manager: InstanceType<typeof AgentManager>;
  let parentSessionId: string;
  const usage = (percent: number, contextWindow = 500000) => ({
    tokens: percent * contextWindow / 100, contextWindow, percent,
  });
  const configure = (responses: any) => { process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES = JSON.stringify(responses); };
  const records = (info: AgentInfo) => fs.readFileSync(info.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const countStats = (info: AgentInfo) => records(info).filter((record) => record.type === "get_session_stats").length;

  beforeEach(async () => {
    process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
    parentSessionId = `context-rpc-${randomUUID()}`;
    manager = new AgentManager();
    await manager.ready();
  });

  afterEach(async () => {
    await manager.shutdown();
    fs.rmSync(path.join(getRunsDir(), parentScopeKey(parentSessionId)), { recursive: true, force: true });
    delete process.env.PI_SUBAGENT_PI_BIN;
    delete process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES;
  });

  test("saves a final native snapshot, resumes the same session without resetting it, and interrupts without extra sampling", async () => {
    configure({ contextResponses: [
      { data: { tokens: { total: 110000 }, contextUsage: usage(12) } },
      { data: { contextUsage: usage(14) } },
    ] });
    await manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"));
    const first = manager.getAgentInfo("worker", parentSessionId);
    expect((await manager.waitAgent(parentSessionId, ["worker"])).event?.finalResponse).toBe("response:first");
    await waitUntil(() => !manager.getAgentInfo("worker", parentSessionId).childProcess);
    expect(formatContextUsage(manager.getAgentInfo("worker", parentSessionId).contextUsage)).toBe("14%/500k");
    expect(countStats(first)).toBeGreaterThanOrEqual(2);

    configure({ contextResponses: [{ hold: true }] });
    expect(await manager.sendMessage(parentSessionId, "worker", "hold resumed")).toEqual({ delivery: "prompt" });
    const resumed = manager.getAgentInfo("worker", parentSessionId);
    const live = manager["live"].get(first.id)!;
    expect(resumed.id).toBe(first.id);
    expect(resumed.sessionFile).toBe(first.sessionFile);
    expect(resumed.contextUsage).toEqual(usage(14));
    expect(resumed.childProcess?.pid).not.toBe(first.childProcess?.pid);
    await waitUntil(() => records(resumed).filter((record) => record.pid === resumed.childProcess?.pid && record.type === "get_session_stats").length === 1);
    const before = countStats(resumed);
    await manager.interruptAgent(parentSessionId, "worker");
    await live.contextRefresh;
    expect(countStats(resumed)).toBe(before);
    expect(live.pending.size).toBe(0);
    expect(live.contextRefresh).toBeUndefined();
    expect(manager.getAgentInfo("worker", parentSessionId)).toMatchObject({ status: "interrupted", contextUsage: usage(14) });
    expect(records(resumed).filter((record) => record.type === "prompt").map((record) => record.message)).toEqual(["first", "hold resumed"]);
  });

  test("settled continuation waits for a timed-out final query instead of steering the exiting process", async () => {
    configure({ contextResponses: [{ data: { contextUsage: usage(10) } }, { hold: true }] });
    await manager.spawnAgent(spawnParams(parentSessionId, "worker", "first"));
    const first = manager.getAgentInfo("worker", parentSessionId);
    const oldLive = manager["live"].get(first.id)!;
    const completed = await manager.waitAgent(parentSessionId, ["worker"]);
    expect(completed.event?.status).toBe("completed");
    expect(oldLive.expectedExit).toBe(true);
    expect(oldLive.processFinished).toBe(false);
    expect(manager.getAgentInfo("worker", parentSessionId).contextUsage).toEqual(usage(10));
    expect(await manager.sendMessage(parentSessionId, "worker", "hold continuation")).toEqual({ delivery: "prompt" });
    expect(oldLive.processFinished).toBe(true);
    await oldLive.contextRefresh;
    expect(oldLive.pending.size).toBe(0);
    const resumed = manager.getAgentInfo("worker", parentSessionId);
    expect(resumed.childProcess?.pid).not.toBe(first.childProcess?.pid);
    const sessionRecords = records(resumed);
    expect(sessionRecords.filter((record) => record.type === "started")).toHaveLength(2);
    expect(sessionRecords.filter((record) => record.type === "steer")).toHaveLength(0);
    expect(sessionRecords.filter((record) => record.type === "prompt").map((record) => record.message)).toEqual(["first", "hold continuation"]);
    expect(resumed.contextUsage).toEqual(usage(10));
  });

  test("steer and event sampling interleave without losing a newer snapshot or process ownership", async () => {
    configure({
      contextResponses: [{ data: { contextUsage: usage(10) } }, { data: { contextUsage: usage(12) } }],
      steerDelayMs: 150,
      steerEvents: [{ event: { type: "message_end", message: { role: "user", content: "steered" } } }],
    });
    await manager.spawnAgent(spawnParams(parentSessionId, "worker", "hold steer"));
    await waitUntil(() => manager.getAgentInfo("worker", parentSessionId).contextUsage?.percent === 10);
    const started = manager.getAgentInfo("worker", parentSessionId);
    const delivery = manager.sendMessage(parentSessionId, "worker", "new direction");
    await waitUntil(() => manager.getAgentInfo("worker", parentSessionId).contextUsage?.percent === 12);
    expect(await delivery).toEqual({ delivery: "steer" });
    expect(manager.getAgentInfo("worker", parentSessionId)).toMatchObject({
      status: "running", contextUsage: usage(12), childProcess: started.childProcess, lastTaskMessage: "new direction",
    });
  });

  test("a successful compaction in the old response's stdout chunk invalidates it even if the next query fails", async () => {
    configure({
      contextResponses: [
        { data: { contextUsage: usage(10) } },
        { data: { contextUsage: usage(95) }, events: [{ type: "compaction_end", result: { summary: "compacted" } }] },
        { success: false },
      ],
      steerEvents: [{ event: { type: "turn_end" } }],
    });
    await manager.spawnAgent(spawnParams(parentSessionId, "worker", "hold compaction"));
    await waitUntil(() => manager.getAgentInfo("worker", parentSessionId).contextUsage?.percent === 10);
    await manager.sendMessage(parentSessionId, "worker", "compact now");
    const info = manager.getAgentInfo("worker", parentSessionId);
    const live = manager["live"].get(info.id)!;
    await waitUntil(() => live.contextEpoch === 1 && countStats(info) === 3 && !live.contextRefresh);
    expect(formatContextUsage(manager.getAgentInfo("worker", parentSessionId).contextUsage)).toBe("?%/500k");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(countStats(info)).toBe(3);
    expect(manager.getAgentInfo("worker", parentSessionId).status).toBe("running");
  });

  test("different children use their own native windows rather than a parent model window", async () => {
    configure({ contextResponses: [{ data: { contextUsage: usage(10, 500000) } }] });
    await manager.spawnAgent(spawnParams(parentSessionId, "small", "hold small"));
    configure({ contextResponses: [{ data: { contextUsage: usage(20, 1050000) } }] });
    await manager.spawnAgent({ ...spawnParams(parentSessionId, "large", "hold large"), inheritedModelId: "template-model" });
    await waitUntil(() => Boolean(manager.getAgentInfo("small", parentSessionId).contextUsage && manager.getAgentInfo("large", parentSessionId).contextUsage));
    expect(formatContextUsage(manager.getAgentInfo("small", parentSessionId).contextUsage)).toBe("10%/500k");
    expect(formatContextUsage(manager.getAgentInfo("large", parentSessionId).contextUsage)).toBe("20%/1.05M");
  });

  test("old final responses and process-exit cleanup cannot mutate a replacement owner's record", async () => {
    configure({ contextResponses: [
      { data: { contextUsage: usage(10) } },
      { data: { contextUsage: usage(12) }, delayMs: 150 },
    ] });
    await manager.spawnAgent(spawnParams(parentSessionId, "worker", "slow first"));
    const initial = manager.getAgentInfo("worker", parentSessionId);
    const live = manager["live"].get(initial.id)!;
    await manager.waitAgent(parentSessionId, ["worker"]);
    const replacement = {
      ...manager.getAgentInfo("worker", parentSessionId), status: "failed", error: "replacement run",
      contextUsage: usage(67), childProcess: { ...initial.childProcess!, token: "replacement-token" },
    };
    fs.writeFileSync(initial.infoFile, JSON.stringify(replacement));
    manager["handleLine"](live, JSON.stringify({ type: "turn_end" }));
    expect(live.info.childProcess?.token).toBe("replacement-token");
    const before = fs.readFileSync(initial.infoFile, "utf8");
    await live.termination;
    await live.contextRefresh;
    expect(live.processFinished).toBe(true);
    expect(fs.readFileSync(initial.infoFile, "utf8")).toBe(before);
    expect(manager.getAgentInfo("worker", parentSessionId).childProcess?.token).toBe("replacement-token");
  });

  test("unexpected exit rejects pending statistics without reviving ownership or changing failure delivery", async () => {
    configure({ contextResponses: [{ hold: true }] });
    await manager.spawnAgent(spawnParams(parentSessionId, "worker", "crash now"));
    const info = manager.getAgentInfo("worker", parentSessionId);
    const live = manager["live"].get(info.id)!;
    expect((await manager.waitAgent(parentSessionId, ["worker"])).event?.status).toBe("failed");
    await waitUntil(() => !manager.getAgentInfo("worker", parentSessionId).childProcess);
    await live.contextRefresh;
    expect(live.pending.size).toBe(0);
    expect(live.contextRefresh).toBeUndefined();
    const failed = manager.getAgentInfo("worker", parentSessionId);
    expect(failed.status).toBe("failed");
    expect(failed.contextUsage).toBeUndefined();
    expect(failed.childProcess).toBeUndefined();
    expect(countStats(info)).toBe(1);
  });
});

test("real Pi RPC reports current context rather than billing totals and clears pre-compaction usage", async () => {
  const directory = fs.mkdtempSync(path.join(TEST_AGENT_DIR, "native-context-rpc-"));
  const provider = "context-test";
  const model = "context-fixture";
  const api = "openai-completions";
  fs.writeFileSync(path.join(directory, "models.json"), JSON.stringify({
    providers: { [provider]: {
      api, apiKey: "offline-fixture", baseUrl: "http://127.0.0.1:9/v1",
      models: [{ id: model, contextWindow: 500000, maxTokens: 1024, input: ["text"], reasoning: false }],
    } },
  }));
  const makeSession = (count: number, compacted = false, afterCompaction = false) => {
    const session = codingAgent.SessionManager.create(directory, directory);
    session.appendModelChange(provider, model);
    session.appendMessage({ role: "user", content: "saved context", timestamp: 1 });
    const appendAssistant = (tokens: number) => session.appendMessage({
      role: "assistant", content: [{ type: "text", text: "saved response" }],
      api, provider, model, stopReason: "stop", timestamp: 2,
      usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    appendAssistant(50000);
    if (count > 1) appendAssistant(60000);
    if (compacted) session.appendCompaction("saved summary", null, 60000);
    if (afterCompaction) appendAssistant(40000);
    return session.getSessionFile()!;
  };
  const sessions = [makeSession(1), makeSession(2), makeSession(2, true), makeSession(2, true, true)];
  const client = new codingAgent.RpcClient({
    cliPath: path.join(path.dirname(Bun.resolveSync("@earendil-works/pi-coding-agent", import.meta.dir)), "cli.js"),
    cwd: directory, provider, model,
    env: { PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    args: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools", "--session", sessions[0]],
  });
  try {
    await client.start();
    expect((await client.getState()).model).toMatchObject({ provider, id: model });
    const first = await client.getSessionStats();
    expect(first.contextUsage).toEqual({ tokens: 50000, contextWindow: 500000, percent: 10 });
    expect(formatContextUsage(first.contextUsage)).toBe("10%/500k");
    await client.switchSession(sessions[1]);
    const second = await client.getSessionStats();
    expect(second.tokens.total).toBe(110000);
    expect(second.contextUsage).toEqual({ tokens: 60000, contextWindow: 500000, percent: 12 });
    expect(formatContextUsage(second.contextUsage)).toBe("12%/500k");
    await client.switchSession(sessions[2]);
    const compacted = await client.getSessionStats();
    expect(compacted.contextUsage).toEqual({ tokens: null, contextWindow: 500000, percent: null });
    expect(formatContextUsage(compacted.contextUsage)).toBe("?%/500k");
    await client.switchSession(sessions[3]);
    expect(formatContextUsage((await client.getSessionStats()).contextUsage)).toBe("8%/500k");
  } finally {
    await client.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("context usage flows through public tools, child RPC, metadata and the detail footer only, including history", async () => {
  process.env.PI_SUBAGENT_PI_BIN = FAKE_RPC_CHILD;
  process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES = JSON.stringify({
    contextResponses: [10, 12, 14].map((percent) => ({
      data: { tokens: { total: 999999 }, contextUsage: { tokens: percent * 5000, contextWindow: 500000, percent } },
    })),
    steerEvents: [{ event: { type: "turn_end" } }],
  });
  const parentId = `context-full-chain-${randomUUID()}`;
  const scope = path.join(getRunsDir(), parentScopeKey(parentId));
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const ctx: any = {
    mode: "tui", cwd: TEST_AGENT_DIR, model: { provider: "test", id: "fake" },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "fake" }] },
    sessionManager: { getSessionId: () => parentId },
    ui: { notify: mock(() => {}), setWidget() {} },
  };
  const { default: extension } = await import("./index.js");
  const execute = (name: string, params: any) => tools.get(name).execute("context-e2e", params, undefined, undefined, ctx);
  try {
    await extension({
      on(name: string, handler: any) { handlers.set(name, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {},
      getThinkingLevel: () => "high", getActiveTools: () => ["read"],
      getSettings: () => ({ terminal: { showImages: false }, outputPad: 0 }),
    } as any);
    await handlers.get("session_start")({}, ctx);
    const spawned = await execute("spawn_agent", { task_name: "worker", message: "hold context full chain" });
    expect(spawned.content[0].text).toBe("Spawned /worker.");
    await waitUntil(() => getAgent("worker", parentId)?.contextUsage?.percent === 10);
    const overlayFrames: string[] = [];
    let opened = 0;
    ctx.ui.custom = async (create: any) => {
      let component: any;
      let result: any;
      const tui = { terminal: { rows: 35 }, requestRender() {
        if (!(component instanceof SubagentPeekOverlay)) return;
        overlayFrames.push(stripVTControlCharacters(component.render(80).join("\n")));
      } };
      component = create(tui, theme, {}, (value: any) => { result = value; component.dispose?.(); });
      try {
        if (!(component instanceof SubagentPeekOverlay)) {
          const browserLines = component.render(80);
          expect(browserLines.join("\n")).not.toMatch(/ctx |Context:|%\/500k/);
          expect((await execute("send_message", { target: "worker", message: "sample twelve" })).details.delivery).toBe("steer");
          await waitUntil(() => getAgent("worker", parentId)?.contextUsage?.percent === 12);
          expect(component.render(80)).toBe(browserLines);
          component.handleInput("\r");
        } else {
          opened++;
          expect(component.render(80).at(-2)).toContain("│ 12%/500k │ ←/→ agent");
          expect(component.render(80).join("\n")).not.toContain("Context:");
          await execute("send_message", { target: "worker", message: "sample fourteen" });
          await waitUntil(() => overlayFrames.some((frame) => frame.includes("│ 14%/500k │ ←/→ agent")));
          component.handleInput("q");
        }
        return result;
      } finally {
        component.dispose?.();
      }
    };
    await commands.get("subagents").handler("", ctx);
    expect(opened).toBe(1);
    expect((await execute("list_agents", {})).content[0].text).not.toContain("contextUsage");
    expect((await execute("interrupt_agent", { target: "worker" })).details.previous_status).toBe("running");
    const saved = getAgent("worker", parentId)!;
    expect(saved.childProcess).toBeUndefined();
    expect(saved.contextUsage).toEqual({ tokens: 70000, contextWindow: 500000, percent: 14 });
    const beforeHistory = fs.readFileSync(saved.sessionFile, "utf8");
    let historyOpened = 0;
    ctx.ui.custom = async (create: any) => {
      let component: any;
      let result: any;
      component = create({ terminal: { rows: 35 }, requestRender() {} }, theme, {}, (value: any) => {
        result = value;
        component.dispose?.();
      });
      try {
        if (component instanceof SubagentPeekOverlay) {
          historyOpened++;
          expect(component.render(80).at(-2)).toContain("│ 14%/500k │ ←/→ agent");
          component.handleInput("q");
        } else {
          expect(component.render(80).join("\n")).not.toMatch(/ctx |Context:|%\/500k/);
          component.handleInput("\r");
        }
        return result;
      } finally { component.dispose?.(); }
    };
    await commands.get("subagents").handler("", ctx);
    expect(historyOpened).toBe(1);
    expect(fs.readFileSync(saved.sessionFile, "utf8")).toBe(beforeHistory);
    expect(getAgent("worker", parentId)?.childProcess).toBeUndefined();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  } finally {
    await handlers.get("session_shutdown")?.();
    fs.rmSync(scope, { recursive: true, force: true });
    delete process.env.PI_SUBAGENT_PI_BIN;
    delete process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES;
  }
});
