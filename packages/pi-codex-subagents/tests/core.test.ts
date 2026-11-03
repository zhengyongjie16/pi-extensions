import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { configureCoreFixture, deferred, type CoreFixtureState } from "./fixtures/core-sdk-fixture.js";
import { StringDecoder } from "node:string_decoder";
import type { AgentInfo } from "../src/core.js";
import type { ExtensionAPI, ToolExecutionComponent, ToolRenderers } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";

// macOS os.tmpdir() can be too long for a Unix socket address; keep the POSIX root short.
const TEST_AGENT_DIR = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "ps-"));
const CORE_SDK_EXTENSION = path.join(import.meta.dir, "fixtures", "core-sdk-fixture.ts");
const previousTempDir = process.env.PI_SUBAGENT_TEMP_DIR;
process.env.PI_SUBAGENT_TEMP_DIR = TEST_AGENT_DIR;
const previousSdkEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { PI_CODING_AGENT_DIR: TEST_AGENT_DIR, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
fs.writeFileSync(path.join(TEST_AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
afterAll(() => {
  if (previousTempDir === undefined) delete process.env.PI_SUBAGENT_TEMP_DIR;
  else process.env.PI_SUBAGENT_TEMP_DIR = previousTempDir;
  for (const [key, value] of Object.entries(previousSdkEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(TEST_AGENT_DIR, { recursive: true, force: true });
});

const codingAgent = await import("@earendil-works/pi-coding-agent");

const {
  AgentManager,
  EventBroadcaster,
  RpcAssistantStreamState,
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
} = await import("../src/core.js");
const { formatAgentSpecLines, SubagentPeekOverlay } = await import("../src/peek.js");
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

describe("observer stream reconstruction", () => {
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

describe("filesystem error reporting", () => {
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

const configFile = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "config.json");
function writeConfig(config: Record<string, any> = {}) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ defaults: { extensions: [CORE_SDK_EXTENSION] }, ...config }));
}
let fixture: CoreFixtureState;
beforeEach(() => {
  fixture = configureCoreFixture();
  writeConfig();
});
async function released(manager: InstanceType<typeof AgentManager>, info: AgentInfo) {
  await waitUntil(() => !manager["live"].has(info.id), 7000);
}
function sessionMessages(info: AgentInfo): any[] {
  if (!fs.existsSync(info.sessionFile)) return [];
  return fs.readFileSync(info.sessionFile, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.type === "message").map((entry) => entry.message);
}
const markerDir = path.join(TEST_AGENT_DIR, "pi-codex-subagents", os.userInfo().username, "sockets");
const activeMarker = (id: string) => path.join(markerDir, id + ".active.json");
const peekMarker = (id: string) => path.join(markerDir, id + ".peek.json");
// This is the retained observer socket's framing, not a child-engine RPC decoder.
class ObserverJsonlDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  push(chunk: Buffer): string[] {
    const lines = (this.buffer + this.decoder.write(chunk)).split("\n");
    this.buffer = lines.pop()!;
    return lines.filter(Boolean);
  }
}

describe("spawn model and thinking resolution", () => {
  test("caller wins, then the template, then the inherited value, then the default", async () => {
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
    }
  });
});

describe("SDK model validation", () => {
  test.each([
    ["unknown-provider", "fake"], ["test", "not-registered"], ["test", "Fake"],
    ["openai", "gpt"], ["openai", "custom/unregistered"],
  ])("rejects unavailable exact route %s/%s before submitting a prompt", async (provider, modelId) => {
    const parent = "unavailable-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await expect(manager.spawnAgent({ ...spawnParams(parent, "worker", "must not run"), model: { provider, modelId } }))
        .rejects.toThrow(provider + "/" + modelId);
      const info = manager.getAgentInfo("worker", parent);
      expect(info).toMatchObject({ provider, modelId, status: "failed", messageCount: 0 });
      expect(info.finalResponse).toBeUndefined();
      await released(manager, info);
      expect(fixture.instances.flatMap((instance) => instance.inputs)).toEqual([]);
      expect(sessionMessages(info)).toEqual([]);
      expect(completions).toEqual([expect.objectContaining({ status: "failed", error: info.error })]);
      expect((await manager.waitAgent(parent, ["worker"])).event?.id).toBe(completions[0].id);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
    } finally { await manager.shutdown(); }
  });

  test("an explicit extension load error fails startup without falling back to another model", async () => {
    const parent = "bad-extension-" + randomUUID();
    const extension = path.join(TEST_AGENT_DIR, "bad-extension.ts");
    fs.writeFileSync(extension, 'export default () => { throw new Error("explicit fixture load failure"); };');
    writeConfig({ defaults: { extensions: [CORE_SDK_EXTENSION, extension] } });
    const manager = new AgentManager();
    try {
      await expect(manager.spawnAgent(spawnParams(parent, "worker", "must not run"))).rejects.toThrow("explicit fixture load failure");
      const info = manager.getAgentInfo("worker", parent);
      expect(info.status).toBe("failed");
      expect(sessionMessages(info)).toEqual([]);
      await released(manager, info);
    } finally { await manager.shutdown(); fs.rmSync(extension, { force: true }); }
  });

  test("accepts a slash-containing model ID and retains the saved route/resources when templates change", async () => {
    const parent = "saved-route-" + randomUUID();
    const template = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents", "saved-route.md");
    const id = "accounts/fireworks/models/glm-5p2";
    fs.writeFileSync(template, "---\nname: saved-route\nprovider: fireworks\nmodel: " + id + "\n---\nTemplate instructions.");
    const manager = new AgentManager();
    try {
      await manager.spawnAgent({ ...spawnParams(parent, "worker", "first"), agent_type: "saved-route" });
      const first = manager.getAgentInfo("worker", parent);
      await released(manager, first);
      fs.writeFileSync(template, "---\nname: saved-route\nprovider: openai\nmodel: gpt-5\n---\nChanged template.");
      expect(await manager.sendMessage(parent, "worker", "second")).toEqual({ delivery: "prompt" });
      await released(manager, first);
      const info = manager.getAgentInfo("worker", parent);
      expect(info).toMatchObject({ provider: "fireworks", modelId: id, messageCount: 2 });
      expect(fixture.instances).toHaveLength(2);
      expect(fixture.instances[0].requests[0].text).toBe("Template instructions.\n\nfirst");
      expect(fixture.instances[1].requests[0].text).toBe("second");
      expect(info.extensionPaths).toEqual([CORE_SDK_EXTENSION]);
      fixture = configureCoreFixture({ routes: [["test", "fake"]] });
      await expect(manager.sendMessage(parent, "worker", "must not run")).rejects.toThrow("fireworks/" + id);
      expect(manager.getAgentInfo("worker", parent)).toMatchObject({ status: "failed", messageCount: 2, provider: "fireworks", modelId: id });
      expect(fixture.instances.flatMap((instance) => instance.requests)).toEqual([]);
    } finally { await manager.shutdown(); fs.rmSync(template, { force: true }); }
  });

  test.each(["failed", "interrupted"] as const)("records distinct startup failures after a previous %s run", async (prior) => {
    const parent = "retry-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", prior === "failed" ? "fail old" : "hold old"));
      if (prior === "interrupted") await manager.interruptAgent(parent, "worker");
      const initial = manager.getAgentInfo("worker", parent);
      await released(manager, initial);
      expect(manager.getAgentInfo("worker", parent).status).toBe(prior);
      fixture = configureCoreFixture({ routes: [["test", "other"]] });
      let previousId = manager["mailbox"].at(-1)!.id;
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = completions.length;
        await expect(manager.sendMessage(parent, "worker", "must not run")).rejects.toThrow("test/fake");
        const info = manager.getAgentInfo("worker", parent);
        await released(manager, info);
        expect(info).toMatchObject({ status: "failed", messageCount: 1 });
        expect(info.finalResponse).toBeUndefined();
        expect(completions.slice(before)).toEqual([expect.objectContaining({ status: "failed", error: info.error })]);
        expect(completions.at(-1).id).not.toBe(previousId);
        previousId = completions.at(-1).id;
        expect((await manager.waitAgent(parent, ["worker"])).event?.id).toBe(previousId);
      }
      expect(fixture.instances.flatMap((instance) => instance.inputs)).toEqual([]);
    } finally { await manager.shutdown(); }
  });
});

describe("SDK lifecycle and cancellation races", () => {
  test("spawn returns on native acceptance, then releases and reopens the same native history", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = "lifecycle-" + randomUUID();
    const manager = new AgentManager();
    try {
      expect(await manager.spawnAgent(spawnParams(parent, "worker", "hold first"))).toEqual({ task_name: "/worker", nickname: null });
      const info = manager.getAgentInfo("worker", parent);
      expect(info.status).toBe("running");
      const firstSession = manager["live"].get(info.id)!.session!;
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      gate.resolve();
      await released(manager, info);
      expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:hold first");
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(await manager.sendMessage(parent, "worker", "second")).toEqual({ delivery: "prompt" });
      const secondSession = manager["live"].get(info.id)?.session;
      if (secondSession) expect(secondSession).not.toBe(firstSession);
      await released(manager, info);
      expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:second");
      expect(sessionMessages(info).filter((entry) => entry.role !== "system").map((entry) => entry.role)).toEqual(["user", "assistant", "user", "assistant"]);
      const reopened = codingAgent.SessionManager.open(info.sessionFile, path.dirname(info.sessionFile), info.cwd);
      expect(reopened.buildSessionContext().messages.filter((message) => message.role !== "system")).toHaveLength(4);
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
      expect(fixture.instances[1].requests[0].context.messages.filter((entry: any) => entry.role !== "system").map((entry: any) => entry.role)).toEqual(["user", "assistant", "user"]);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      expect(fs.existsSync(peekMarker(info.id))).toBe(false);
      if (process.platform !== "win32") expect(fs.existsSync(getSocketPath(info.id))).toBe(false);
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test("steers a running native session without opening a second session", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = "steer-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold initial"));
      expect(await manager.sendMessage(parent, "worker", "next instruction")).toEqual({ delivery: "steer" });
      expect(fixture.instances).toHaveLength(1);
      gate.resolve();
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:next instruction");
      expect(info.sessionFile).toBe(manager.getAgentInfo("worker", parent).sessionFile);
      expect(fixture.instances[0].inputs.map((event) => event.source)).toEqual(["rpc", "rpc"]);
      expect(completions).toHaveLength(1);
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test.each(["fail", "aborted"])("treats normal prompt resolution with %s stopReason as a non-success", async (command) => {
    const parent = "stop-reason-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", command + " now"));
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      expect(manager.getAgentInfo("worker", parent).status).toBe("failed");
      expect(manager.readAgentResponse("worker", parent).error).toContain(command === "fail" ? "fixture failure" : "aborted");
      expect(completions).toHaveLength(1);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally { await manager.shutdown(); }
  });

  test("handled input ends with this run's empty response, never the previous answer", async () => {
    const parent = "handled-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:first");
      await manager.sendMessage(parent, "worker", "handled empty");
      await released(manager, info);
      const after = manager.getAgentInfo("worker", parent);
      expect(after.status).toBe("completed");
      expect(after.finalResponse ?? "").toBe("");
      expect(after.messageCount).toBe(2);
      expect(fixture.instances[1].requests).toEqual([]);
      expect(completions).toHaveLength(2);
      expect(completions[1].finalResponse ?? "").toBe("");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(manager.getAgentInfo("worker", parent).status).toBe("completed");
    } finally { await manager.shutdown(); }
  });

  test("handled input that starts native work is not finalized or disposed before native idle", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = "handled-work-" + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "handled work"));
      const info = manager.getAgentInfo("worker", parent);
      expect(manager["live"].has(info.id)).toBe(true);
      expect(fixture.instances[0].activeStreams).toBe(1);
      expect(fixture.instances[0].shutdowns).toBe(0);
      expect(info.status).toBe("running");
      gate.resolve();
      await released(manager, info);
      expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:hold handled-owned-work");
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test.each(["initialization", "input"])("interrupt tracks late %s until it exits, without rollback or duplicate completion", async (phase) => {
    const gate = deferred();
    fixture = configureCoreFixture(phase === "initialization" ? { startupGate: gate.promise } : {
      input: async () => { await gate.promise; },
    });
    const parent = "cancel-" + phase + "-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    const pending = manager.spawnAgent(spawnParams(parent, "worker", "hold late")).then(() => undefined, (error) => error);
    try {
      await waitUntil(() => phase === "initialization" ? fixture.instances[0]?.events.includes("session_start") : Boolean(fixture.instances[0]?.inputs.length));
      const info = manager.getAgentInfo("worker", parent);
      const interruption = manager.interruptAgent(parent, "worker");
      await waitUntil(() => manager.getAgentInfo("worker", parent).status === "interrupted");
      expect(manager["live"].has(info.id)).toBe(true);
      expect(fixture.instances[0].shutdowns).toBe(0);
      gate.resolve();
      await interruption;
      expect(await pending).toBeInstanceOf(Error);
      await released(manager, info);
      expect(manager.getAgentInfo("worker", parent).status).toBe("interrupted");
      expect(completions).toEqual([]); // Explicit interrupt is waitable, not an automatic notification.
      expect((await manager.waitAgent(parent, ["worker"])).event?.status).toBe("interrupted");
      expect(manager["mailbox"].filter((event) => event.parentSessionId === parent)).toEqual([]);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fixture.instances[0].activeStreams).toBe(0);
      if (phase === "initialization") expect(fixture.instances[0].inputs).toEqual([]);
    } finally { gate.resolve(); await pending; await manager.shutdown(); }
  });

  test.each(["initialization", "input"])("startup timeout follows late %s to actual release", async (phase) => {
    const gate = deferred();
    fixture = configureCoreFixture(phase === "initialization" ? { startupGate: gate.promise } : { input: async () => { await gate.promise; } });
    const original = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: any, delay: number, ...args: any[]) =>
      original(callback, delay === 15000 ? 300 : delay, ...args)) as typeof setTimeout);
    const parent = "startup-timeout-" + phase + "-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event), onError() {} });
    const pending = manager.spawnAgent(spawnParams(parent, "worker", "hold late")).then(() => undefined, (error) => error);
    try {
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/timed out|timeout/i);
      const info = manager.getAgentInfo("worker", parent);
      expect(info.status).toBe("failed");
      expect(manager["live"].has(info.id)).toBe(true);
      expect(fixture.instances[0].shutdowns).toBe(0);
      gate.resolve();
      await released(manager, info);
      expect(completions).toHaveLength(1);
      expect(manager.getAgentInfo("worker", parent).status).toBe("failed");
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fixture.instances[0].activeStreams).toBe(0);
    } finally { timers.mockRestore(); gate.resolve(); await pending; await manager.shutdown(); }
  });

  test("non-cooperative cancellation returns finitely and blocks reopening until actual release", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise, ignoreAbort: true });
    const parent = "non-cooperative-" + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold uncooperative"));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo("worker", parent);
      const started = Date.now();
      await expect(manager.interruptAgent(parent, "worker")).rejects.toThrow(/timed out|cleanup|closing/i);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(manager.getAgentInfo("worker", parent).status).toBe("interrupted");
      expect(manager["live"].has(info.id)).toBe(true);
      expect(fs.existsSync(activeMarker(info.id))).toBe(true);
      await expect(manager.sendMessage(parent, "worker", "must not reopen")).rejects.toThrow(/timed out|cleanup|closing/i);
      expect(fixture.instances).toHaveLength(1);
      expect(fixture.instances[0].shutdowns).toBe(0);
      gate.resolve();
      await released(manager, info);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      await manager.sendMessage(parent, "worker", "recovered");
      await released(manager, info);
      expect(fixture.instances).toHaveLength(2);
      expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:recovered");
      expect(errors.length).toBeGreaterThan(0);
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test("publishes completion before extension shutdown, but closing cannot reopen the JSONL", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ shutdownGate: gate.promise });
    const parent = "shutdown-gate-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event), onError() {} });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      await waitUntil(() => fixture.instances[0].shutdowns === 1);
      const info = manager.getAgentInfo("worker", parent);
      expect(info.status).toBe("completed");
      expect(completions).toHaveLength(1);
      expect(manager["live"].has(info.id)).toBe(true);
      await expect(manager.sendMessage(parent, "worker", "must not reopen")).rejects.toThrow(/timed out|cleanup|closing/i);
      expect(fixture.instances).toHaveLength(1);
      gate.resolve();
      await released(manager, info);
      await manager.sendMessage(parent, "worker", "second");
      await released(manager, info);
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test("a late steer cannot claim queued success or dispose the session before its input exits", async () => {
    const response = deferred();
    const input = deferred();
    fixture = configureCoreFixture({ responseGate: response.promise, input: async (event) => {
      if (event.streamingBehavior === "steer") await input.promise;
    } });
    const parent = "late-steer-" + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold initial"));
      const info = manager.getAgentInfo("worker", parent);
      const pending = manager.sendMessage(parent, "worker", "late steer").then(() => undefined, (error) => error);
      await waitUntil(() => fixture.instances[0].inputs.length === 2);
      response.resolve();
      await waitUntil(() => manager.getAgentInfo("worker", parent).status === "completed");
      expect(manager["live"].has(info.id)).toBe(true);
      expect(fixture.instances[0].shutdowns).toBe(0);
      input.resolve();
      expect(await pending).toBeInstanceOf(Error);
      await released(manager, info);
      expect(fixture.instances[0].requests).toHaveLength(1);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:hold initial");
    } finally { response.resolve(); input.resolve(); await manager.shutdown(); }
  });

  test.each([false, true])("steer timeout cancels the run and owns late input until cleanup (ignoreAbort=%s)", async (ignoreAbort) => {
    const response = deferred();
    const input = deferred();
    fixture = configureCoreFixture({ responseGate: response.promise, ignoreAbort, input: async (event) => {
      if (event.streamingBehavior === "steer") await input.promise;
    } });
    const parent = "steer-timeout-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event), onError() {} });
    let timers: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold initial"));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo("worker", parent);
      const live = manager["live"].get(info.id)!;
      const original = globalThis.setTimeout;
      timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: any, delay: number, ...args: any[]) =>
        original(callback, delay === 15000 || delay === 2000 ? 100 : delay, ...args)) as typeof setTimeout);
      await expect(manager.sendMessage(parent, "worker", "must not execute late")).rejects.toThrow(/steering acceptance/);
      expect(live.closing).toBe(true);
      expect(live.cancellation.signal.aborted).toBe(true);
      expect(live.pendingSteers.size).toBe(1);
      expect(manager.getAgentInfo("worker", parent).status).toBe("failed");
      expect(completions).toHaveLength(1);
      expect(completions[0].error).toMatch(/steering acceptance/);
      expect(fs.existsSync(activeMarker(info.id))).toBe(true);
      expect(fixture.instances[0].shutdowns).toBe(0);
      await expect(manager.sendMessage(parent, "worker", "must not reopen")).rejects.toThrow(/closing/);
      expect(fixture.instances).toHaveLength(1);
      // Even after input returns, non-cooperative model work still owns the file.
      input.resolve();
      await waitUntil(() => live.pendingSteers.size === 0);
      if (ignoreAbort) {
        expect(manager["live"].get(info.id)).toBe(live);
        expect(fixture.instances[0].shutdowns).toBe(0);
      }
      response.resolve();
      await released(manager, info);
      expect(fixture.instances[0].requests.map((request) => request.text)).toEqual(["hold initial"]);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(completions).toHaveLength(1);
      expect(manager.getAgentInfo("worker", parent).status).toBe("failed");
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      expect(sessionMessages(info).some((message) => JSON.stringify(message).includes("must not execute late"))).toBe(false);
      timers.mockRestore();
      await manager.sendMessage(parent, "worker", "clean recovery");
      await released(manager, info);
      expect(manager.getAgentInfo("worker", parent).sessionFile).toBe(info.sessionFile);
      expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:clean recovery");
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
    } finally { timers?.mockRestore(); input.resolve(); response.resolve(); await manager.shutdown(); }
  });

  test("ordinary steer rejection preserves the active run, even with timeout-like error text", async () => {
    const response = deferred();
    fixture = configureCoreFixture({ responseGate: response.promise });
    const parent = "steer-rejection-" + randomUUID();
    const manager = new AgentManager();
    let steer: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold original"));
      const info = manager.getAgentInfo("worker", parent);
      const live = manager["live"].get(info.id)!;
      const rejection = new Error("Timed out waiting for agent /worker steering acceptance.");
      steer = spyOn(live.session!, "steer").mockRejectedValue(rejection);
      await expect(manager.sendMessage(parent, "worker", "rejected input")).rejects.toBe(rejection);
      expect(live.cancellation.signal.aborted).toBe(false);
      expect(live.closing).toBe(false);
      expect(live.pendingSteers.size).toBe(0);
      expect(manager.getAgentInfo("worker", parent)).toMatchObject({ status: "running", lastTaskMessage: "hold original" });
      steer.mockRestore();
      response.resolve();
      await released(manager, info);
      expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:hold original");
    } finally { steer?.mockRestore(); response.resolve(); await manager.shutdown(); }
  });

  test.each(["completed", "interrupted"])("a later steer timeout cannot replace an already %s run", async (status) => {
    const response = deferred();
    const input = deferred();
    fixture = configureCoreFixture({ responseGate: response.promise, input: async (event) => {
      if (event.streamingBehavior === "steer") await input.promise;
    } });
    const parent = "steer-finalized-" + status + "-" + randomUUID();
    const manager = new AgentManager({ onError() {} });
    let timers: ReturnType<typeof spyOn> | undefined;
    let interruption: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold original"));
      const info = manager.getAgentInfo("worker", parent);
      const original = globalThis.setTimeout;
      timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: any, delay: number, ...args: any[]) =>
        original(callback, delay === 15000 ? 150 : delay, ...args)) as typeof setTimeout);
      const pending = manager.sendMessage(parent, "worker", "late input").catch((error) => error);
      await waitUntil(() => fixture.instances[0].inputs.length === 2);
      if (status === "completed") response.resolve();
      else interruption = manager.interruptAgent(parent, "worker");
      await waitUntil(() => manager.getAgentInfo("worker", parent).status === status);
      expect((await pending).message).toMatch(/steering acceptance/);
      expect(manager.getAgentInfo("worker", parent).status).toBe(status);
      input.resolve();
      response.resolve();
      await interruption;
      await released(manager, info);
      expect(manager.getAgentInfo("worker", parent).status).toBe(status);
      expect(fixture.instances[0].requests).toHaveLength(1);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally { timers?.mockRestore(); input.resolve(); response.resolve(); await interruption; await manager.shutdown(); }
  });

  test.each(["startup", "input"])("ctx.shutdown during %s cancels the child without stopping its parent", async (phase) => {
    fixture = configureCoreFixture({ shutdownAtStart: phase === "startup" });
    const parent = "extension-shutdown-" + phase + "-" + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", phase === "input" ? "shutdown input" : "must not run")).catch(() => {});
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      expect(manager.getAgentInfo("worker", parent).status).toBe("interrupted");
      expect(fixture.instances[0].requests).toEqual([]);
      expect(fixture.instances[0].shutdowns).toBe(1);
      fixture = configureCoreFixture();
      await manager.spawnAgent(spawnParams(parent, "sibling", "parent still alive"));
      await released(manager, manager.getAgentInfo("sibling", parent));
      expect(manager.readAgentResponse("sibling", parent).status).toBe("completed");
    } finally { await manager.shutdown(); }
  });

  test("shutdown takes ownership of pending initialization and refuses all new submissions", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ startupGate: gate.promise });
    const parent = "manager-shutdown-" + randomUUID();
    const manager = new AgentManager();
    const pending = manager.spawnAgent(spawnParams(parent, "worker", "must not run")).then(() => undefined, (error) => error);
    try {
      await waitUntil(() => fixture.instances[0]?.events.includes("session_start"));
      const shutdown = manager.shutdown();
      await expect(manager.spawnAgent(spawnParams(parent, "new", "must not run"))).rejects.toThrow(/abort|shut/i);
      await expect(manager.sendMessage(parent, "worker", "must not run")).rejects.toThrow(/abort|shut/i);
      gate.resolve();
      await shutdown;
      expect(await pending).toBeInstanceOf(Error);
      expect(fixture.instances[0].inputs).toEqual([]);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(manager["live"].size).toBe(0);
      await expect(manager.spawnAgent(spawnParams(parent, "after", "must not run"))).rejects.toThrow(/abort|shut/i);
    } finally { gate.resolve(); await pending; await manager.shutdown(); }
  });

  test("rejects concurrent resumes while one initialization is pending", async () => {
    const parent = "concurrent-resume-" + randomUUID();
    const manager = new AgentManager();
    const gate = deferred();
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      fixture = configureCoreFixture({ startupGate: gate.promise });
      const first = manager.sendMessage(parent, "worker", "hold resume");
      await waitUntil(() => fixture.instances[0]?.events.includes("session_start"));
      await expect(manager.sendMessage(parent, "worker", "duplicate")).rejects.toThrow(/starting|startup/i);
      gate.resolve();
      expect(await first).toEqual({ delivery: "prompt" });
      expect(fixture.instances).toHaveLength(1);
      expect(manager.getAgentInfo("worker", parent).messageCount).toBe(2);
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test("a model-response deadline does not cover tool execution", async () => {
    const parent = "tool-deadline-" + randomUUID();
    const manager = new AgentManager({ modelResponseTimeoutMs: 50 });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "tool hold"));
      await waitUntil(() => fixture.instances[0]?.activeTools === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(manager.getAgentInfo("worker", parent).status).toBe("running");
      await manager.interruptAgent(parent, "worker");
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      expect(fixture.instances[0].activeTools).toBe(0);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally { await manager.shutdown(); }
  });

  test("times out an endlessly streaming assistant response and releases its native resources", async () => {
    const parent = "response-deadline-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ modelResponseTimeoutMs: 80, onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "stream forever"));
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      expect(manager.readAgentResponse("worker", parent).error).toContain("Model response exceeded 80 ms");
      expect(manager.getAgentInfo("worker", parent).status).toBe("failed");
      expect(completions).toHaveLength(1);
      expect(fixture.instances[0].activeStreams).toBe(0);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally { await manager.shutdown(); }
  });

  test("stream observation is delta-only and cannot mutate the SDK's assistant message", async () => {
    const parent = "delta-observer-" + randomUUID();
    const manager = new AgentManager({ modelResponseTimeoutMs: 2000 });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "stream forever"));
      const info = manager.getAgentInfo("worker", parent);
      const [sync, update] = await readSocketEvents(getSocketPath(info.id), 2);
      expect(sync.status).toBe("calling");
      expect(sync.partialMessage.content[0]).toMatchObject({ type: "toolCall", id: "stream-call", name: "fixture_hold" });
      expect(update.type).toBe("message_update");
      expect(update.message).toBeUndefined();
      expect(update.assistantMessageEvent.partial).toBeUndefined();
      expect(fixture.instances[0].requests[0].message.content).toEqual([
        { type: "toolCall", id: "stream-call", name: "fixture_hold", arguments: {} },
      ]);
    } finally { await manager.shutdown(); }
  });

  test("observer exceptions stay outside native persistence and cannot skip cleanup", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = "observer-failure-" + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold response"));
      const info = manager.getAgentInfo("worker", parent);
      const live = manager["live"].get(info.id)!;
      const broadcast = live.broadcaster.broadcast.bind(live.broadcaster);
      live.broadcaster.broadcast = (event: any) => {
        if (event.type === "message_end" && event.message.role === "assistant") throw new Error("observer fixture failure");
        broadcast(event);
      };
      gate.resolve();
      await released(manager, info);
      expect(sessionMessages(info).filter((message) => message.role === "assistant")).toHaveLength(1);
      expect(errors.some((error) => error.message.includes("observer fixture failure"))).toBe(true);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test("repeated runs leave no sessions, timers, sockets or extension work active", async () => {
    const parent = "resource-cycles-" + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "cycle zero"));
      const info = manager.getAgentInfo("worker", parent);
      for (let cycle = 0; cycle < 10; cycle++) {
        if (cycle) await manager.sendMessage(parent, "worker", "cycle " + cycle);
        const live = manager["live"].get(info.id);
        await released(manager, info);
        expect(manager["live"].size).toBe(0);
        expect(live?.modelResponseTimer).toBeUndefined();
        expect(live?.session?.["_eventListeners"]).toEqual([]);
        expect(live?.session?.["_unsubscribeAgent"]).toBeUndefined();
        expect(live?.broadcaster["server"]).toBeNull();
        expect(live?.broadcaster["connections"]).toEqual([]);
        expect(live?.logger["stream"]).toBeNull();
        expect(fs.existsSync(activeMarker(info.id))).toBe(false);
        if (process.platform !== "win32") expect(fs.existsSync(getSocketPath(info.id))).toBe(false);
        expect(fs.existsSync(peekMarker(info.id))).toBe(false);
      }
      expect(fixture.instances).toHaveLength(10);
      expect(fixture.instances.map((instance) => [instance.shutdowns, instance.activeStreams, instance.activeTools]))
        .toEqual(Array.from({ length: 10 }, () => [1, 0, 0]));
      expect(sessionMessages(info).filter((message) => message.role === "user")).toHaveLength(10);
      expect(sessionMessages(info).filter((message) => message.role === "assistant")).toHaveLength(10);
    } finally { await manager.shutdown(); }
  });
});

describe("startup storage failures", () => {
  test("records startup failure causes instead of leaving agents starting", async () => {
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
      expect(manager["live"].has(failed.id)).toBe(false);
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
        status: "interrupted",
        messageCount: 0,
      });
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
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

});

describe("completion delivery", () => {
  test("publishes unclaimed successful and failed completions", async () => {
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
      expect(completions.find((event) => event.agentName === "/crashed").error).toContain("fixture failure");
    } finally {
      await manager.shutdown();
      fs.rmSync(scope, { recursive: true, force: true });
    }
  });

  test("suppresses automatic delivery while wait tools claim completions", async () => {
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
    }
  });

  test("releases suppressed completions when wait_all_agents is cancelled", async () => {
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
    }
  });

  test("reports active and inactive lifecycle transitions", async () => {
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
      const rejection = spyOn(codingAgent.AgentSession.prototype, "prompt").mockRejectedValueOnce(new Error("fixture prompt rejection"));
      try { await expect(manager.sendMessage(parentSessionId, "worker", "reject restart")).rejects.toThrow("fixture prompt rejection"); }
      finally { rejection.mockRestore(); }
      expect(manager.getAgentInfo("worker", parentSessionId)).toMatchObject({
        status: "completed",
        finalResponse: settled.finalResponse,
        completedAt: settled.completedAt,
      });
      expect(manager["live"].has(settled.id)).toBe(false);
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
    }
  });
});

describe("extension completion delivery and TUI", () => {
  test("collects native codemode renderers through the real extension API without registering or activating another tool", async () => {
    const { default: subagentExtension } = await import("../src/index.js");
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
          setWidget() {},
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
        additionalExtensionPaths: [${JSON.stringify(path.join(import.meta.dir, "..", "src", "index.ts"))}],
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
        cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8", timeout: 30_000,
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
        setWidget() {},
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
    const { default: subagentExtension } = await import("../src/index.js");
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
      const { default: subagentExtension } = await import("../src/index.js");

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
      const ctx: any = { mode: "tui", sessionManager: { getSessionId: () => parentId }, ui: { notify, setWidget() {} } };
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
        const controlNames = ["spawnAgent", "sendMessage", "interruptAgent"] as const;
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
    fs.writeFileSync(configFile, JSON.stringify({ defaults: { extensions: [CORE_SDK_EXTENSION] }, models: ["test/fake:high", "typo/nope"], modelsFromEnabledModels: true }));
    const { default: subagentExtension } = await import("../src/index.js");
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
      fs.writeFileSync(configFile, JSON.stringify({ defaults: { extensions: [CORE_SDK_EXTENSION] } }));
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
    const decoder = new ObserverJsonlDecoder();
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

  test("forwards non-execution lifecycle events even when they carry parent metadata", async () => {
    const values = [
      { type: "agent_start" },
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
      const decoder = new ObserverJsonlDecoder();
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

describe("SDK business scope, waits and resources", () => {
  test("identical task names stay parent-scoped; all-sessions is only a read view", async () => {
    const parentA = "scope-a-" + randomUUID();
    const parentB = "scope-b-" + randomUUID();
    const manager = new AgentManager();
    try {
      await Promise.all([
        manager.spawnAgent(spawnParams(parentA, "/review/api/", "hold a")),
        manager.spawnAgent(spawnParams(parentB, "review/api", "hold b")),
      ]);
      const a = manager.getAgentInfo("review/api", parentA);
      const b = manager.getAgentInfo("review/api", parentB);
      expect(a.id).not.toBe(b.id);
      expect(a.sessionFile).not.toBe(b.sessionFile);
      expect(manager.listAgents("review/", parentA)).toEqual([
        expect.objectContaining({ agent_name: "/review/api", agent_status: "running", last_task_message: "hold a" }),
      ]);
      const all = manager.listAgents(undefined, parentA, true).filter((entry) => [parentA, parentB].includes(entry.parent_session_id!));
      expect(all).toHaveLength(2);
      expect(new Set(all.map((entry) => entry.parent_session_id))).toEqual(new Set([parentA, parentB]));
      await expect(manager.sendMessage("unrelated", "review/api", "must not deliver")).rejects.toThrow("Agent not found");
      await expect(manager.interruptAgent("unrelated", "review/api")).rejects.toThrow("Agent not found");
      await expect(manager.spawnAgent(spawnParams(parentA, "review/api", "duplicate"))).rejects.toThrow(/already exists/);
      await manager.interruptAgent(parentA, "review/api");
      expect(manager.getAgentInfo("review/api", parentB).status).toBe("running");
      expect((await manager.waitAgent(parentA, ["review/api"])).event?.status).toBe("interrupted");
      expect(fixture.instances[1].shutdowns).toBe(0);
    } finally { await manager.shutdown(); }
  });

  test("read is non-consuming, wait cancellation leaves work alive, and default wait-all targets do not cross parents", async () => {
    const parent = "wait-contract-" + randomUUID();
    const other = "wait-other-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    const controller = new AbortController();
    try {
      await manager.spawnAgent(spawnParams(parent, "one", "first"));
      const info = manager.getAgentInfo("one", parent);
      await released(manager, info);
      const first = manager.readAgentResponse("one", parent);
      expect(manager.readAgentResponse("one", parent)).toEqual(first);
      expect(completions).toHaveLength(1);
      expect((await manager.waitAgent(parent, ["one"])).event?.id).toBe(completions[0].id);
      expect(manager.readAgentResponse("one", parent)).toEqual(first);
      await manager.spawnAgent(spawnParams(parent, "two", "hold waiting"));
      await manager.spawnAgent(spawnParams(other, "foreign", "hold other"));
      const waiting = manager.waitAgent(parent, ["two"], controller.signal);
      controller.abort();
      await expect(waiting).rejects.toThrow(/abort/i);
      expect(manager.getAgentInfo("two", parent).status).toBe("running");
      expect(manager.getAgentInfo("foreign", other).status).toBe("running");
      await manager.interruptAgent(parent, "two");
      const all = await manager.waitAllAgents(parent);
      expect(all.responses).toEqual([]); // Interrupt removes its name from implicit wait-all targets.
      expect((await manager.waitAllAgents(parent, ["two"])).responses).toEqual([expect.objectContaining({ agent_name: "/two", status: "interrupted" })]);
      expect(manager.getAgentInfo("foreign", other).status).toBe("running");
      expect(completions).toHaveLength(1);
    } finally { await manager.shutdown(); }
  });

  test("a second manager can observe but cannot take over an active SDK session file", async () => {
    const parent = "external-owner-" + randomUUID();
    const owner = new AgentManager();
    const observer = new AgentManager();
    try {
      await owner.spawnAgent(spawnParams(parent, "worker", "hold owner"));
      const info = owner.getAgentInfo("worker", parent);
      await observer.ready();
      expect(observer.readAgentResponse("worker", parent).status).toBe("running");
      await expect(observer.sendMessage(parent, "worker", "must not reopen")).rejects.toThrow(/active in another host/);
      await expect(observer.interruptAgent(parent, "worker")).rejects.toThrow(/active in another host/);
      expect(owner.getAgentInfo("worker", parent).status).toBe("running");
      expect(fixture.instances).toHaveLength(1);
      await observer.shutdown();
      expect(owner["live"].has(info.id)).toBe(true);
    } finally { await Promise.all([owner.shutdown(), observer.shutdown()]); }
  });

  test("passes only its SYSTEM path and explicitly resolved template/skill resources, with fresh context", async () => {
    const parent = "resource-policy-" + randomUUID();
    const root = fs.mkdtempSync(path.join(TEST_AGENT_DIR, "resources-"));
    const cwd = path.join(root, "project", "nested");
    fs.mkdirSync(cwd, { recursive: true });
    const ownSystem = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "SYSTEM.md");
    const literalTarget = path.join(root, "literal-target.md");
    fs.writeFileSync(literalTarget, "FORBIDDEN_SECOND_SYSTEM_READ");
    fs.writeFileSync(ownSystem, literalTarget);
    const files: string[] = [];
    const put = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      files.push(file);
    };
    for (const dir of [TEST_AGENT_DIR, root, path.dirname(cwd), cwd]) {
      for (const name of ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md"]) {
        put(path.join(dir, name), "FORBIDDEN_AUTO_RESOURCE " + name);
      }
    }
    put(path.join(cwd, ".pi", "skills", "unselected", "SKILL.md"), "---\nname: unselected\ndescription: FORBIDDEN_AUTO_SKILL\n---\nDo not discover this.");
    const skill = path.join(root, "explicit-skill", "SKILL.md");
    put(skill, "---\nname: explicit-core-skill\ndescription: EXPLICIT_CORE_SKILL_DESCRIPTION\n---\nExplicit skill body.");
    const template = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents", "resource-policy.md");
    put(template, "---\nname: resource-policy\nskills: explicit-core-skill\n---\nEXPLICIT_TEMPLATE_BODY");
    const parentSession = codingAgent.SessionManager.create(cwd, root);
    parentSession.appendMessage({ role: "user", content: "FORBIDDEN_PARENT_CONVERSATION", timestamp: Date.now() });
    const manager = new AgentManager({ projectTrusted: () => true });
    try {
      await manager.spawnAgent({ ...spawnParams(parent, "worker", "assigned work"), cwd, agent_type: "resource-policy",
        parentSessionFile: parentSession.getSessionFile()!, loadedSkillPaths: { "explicit-core-skill": path.dirname(skill) } });
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      expect(info.skillPaths).toEqual([path.dirname(skill)]);
      expect(info.extensionPaths).toEqual([CORE_SDK_EXTENSION]);
      expect(info.cwd).toBe(cwd);
      expect(fixture.instances).toHaveLength(1); // Services must not evaluate the factory twice.
      const request = fixture.instances[0].requests[0];
      expect(request.text).toBe("EXPLICIT_TEMPLATE_BODY\n\nassigned work");
      const input = JSON.stringify(request.context);
      expect(input).toContain(literalTarget.replaceAll("\\", "\\\\"));
      expect(input).toContain("EXPLICIT_CORE_SKILL_DESCRIPTION");
      expect(input).not.toContain("FORBIDDEN_");
      expect(input).not.toContain("Explicit skill body.");
      fs.writeFileSync(ownSystem, "UPDATED_OWN_SYSTEM");
      await manager.sendMessage(parent, "worker", "continuation");
      await released(manager, info);
      expect(JSON.stringify(fixture.instances[1].requests[0].context)).toContain("UPDATED_OWN_SYSTEM");
      expect(fixture.instances[1].requests[0].text).toBe("continuation");
      const nativeList = await codingAgent.SessionManager.list(cwd);
      expect(nativeList.some((session) => session.path === info.sessionFile)).toBe(false);
    } finally {
      await manager.shutdown();
      fs.rmSync(ownSystem, { force: true });
      for (const file of files) fs.rmSync(file, { force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([undefined, "", "read"])("retains the tool-selection three-state contract (%s)", async (tools) => {
    const parent = "tools-contract-" + randomUUID();
    const name = "tool-contract-" + randomUUID();
    const template = path.join(TEST_AGENT_DIR, "pi-codex-subagents", "agents", name + ".md");
    fs.writeFileSync(template, "---\nname: " + name + (tools === undefined ? "" : "\ntools: " + tools) + "\n---\n");
    const manager = new AgentManager();
    try {
      await manager.spawnAgent({ ...spawnParams(parent, "worker", "inspect tools"), agent_type: name });
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      const names = fixture.instances[0].requests[0].context.messages.flatMap((message: any) => message.toolsAdded ?? []).map((tool: any) => tool.name);
      if (tools === "read") expect(names).toEqual(["read"]);
      else if (tools === "") expect(names).toEqual(["fixture_hold"]);
      else expect(names).toEqual(expect.arrayContaining(["read", "bash", "fixture_hold"]));
      expect(info.tools).toBe(tools);
    } finally { await manager.shutdown(); fs.rmSync(template, { force: true }); }
  });
});

describe("SDK native context usage and failure cleanup", () => {
  test("saves the final persisted usage rather than message_end's previous projection or cumulative billing", async () => {
    fixture = configureCoreFixture({ tokens: (text) => text === "first" ? 50000 : 60000 });
    const parent = "native-usage-" + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      expect(manager.getAgentInfo("worker", parent).contextUsage).toEqual({ tokens: 50000, contextWindow: 500000, percent: 10 });
      await manager.sendMessage(parent, "worker", "second");
      await released(manager, info);
      const final = manager.getAgentInfo("worker", parent);
      expect(final.contextUsage).toEqual({ tokens: 60000, contextWindow: 500000, percent: 12 });
      expect(sessionMessages(final).filter((entry) => entry.role === "assistant").reduce((sum, entry) => sum + entry.usage.totalTokens, 0)).toBe(110000);
      expect(formatContextUsage(readInfoFile(final.infoFile)?.contextUsage)).toBe("12%/500k");
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
    } finally { await manager.shutdown(); }
  });

  test("different children sample their own native model windows", async () => {
    fixture = configureCoreFixture({ routes: [["test", "fake", 500000], ["test", "small", 200000]], tokens: 50000 });
    const parent = "native-windows-" + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, "large", "first"));
      await manager.spawnAgent({ ...spawnParams(parent, "small", "second"), model: { provider: "test", modelId: "small" } });
      await Promise.all([released(manager, manager.getAgentInfo("large", parent)), released(manager, manager.getAgentInfo("small", parent))]);
      expect(formatContextUsage(manager.getAgentInfo("large", parent).contextUsage)).toBe("10%/500k");
      expect(formatContextUsage(manager.getAgentInfo("small", parent).contextUsage)).toBe("25%/200k");
    } finally { await manager.shutdown(); }
  });

  test("native compaction invalidates old usage and a restored session can continue the same JSONL", async () => {
    const parent = "compacted-" + randomUUID();
    const manager = new AgentManager();
    const gate = deferred();
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      const saved = codingAgent.SessionManager.open(info.sessionFile, path.dirname(info.sessionFile), info.cwd);
      saved.appendCompaction("saved compacted summary", null, 60000);
      fixture = configureCoreFixture({ responseGate: gate.promise });
      await manager.sendMessage(parent, "worker", "hold after compaction");
      const live = manager["live"].get(info.id)!;
      const usage = live.session!.getContextUsage();
      expect(usage).toEqual({ tokens: null, contextWindow: 500000, percent: null });
      manager["sampleContextUsage"](live);
      expect(manager.getAgentInfo("worker", parent).contextUsage).toEqual(usage);
      gate.resolve();
      await released(manager, info);
      expect(formatContextUsage(manager.getAgentInfo("worker", parent).contextUsage)).toBe("12%/500k");
      expect(fs.readFileSync(info.sessionFile, "utf8")).toContain("saved compacted summary");
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test("a failed final context sample is visible but cannot prevent completion or disposal", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = "sampling-error-" + randomUUID();
    const completions: any[] = [];
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error), onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold sample"));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo("worker", parent);
      const session = manager["live"].get(info.id)!.session!;
      spyOn(session, "getContextUsage").mockImplementation(() => { throw new Error("native sample fixture failure"); });
      gate.resolve();
      await released(manager, info);
      expect(manager.readAgentResponse("worker", parent).status).toBe("completed");
      expect(completions).toHaveLength(1);
      expect(errors.some((error) => error.message.includes("native sample fixture failure"))).toBe(true);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test("sampling is synchronous, validates data, retries an identical failed save, and ignores replaced live objects", async () => {
    const parent = "usage-persistence-" + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold usage"));
      const info = manager.getAgentInfo("worker", parent);
      const live = manager["live"].get(info.id)!;
      const usage = { tokens: 60000, contextWindow: 500000, percent: 12 };
      const sample = spyOn(live.session!, "getContextUsage").mockReturnValue(usage);
      const before = manager.getAgentInfo("worker", parent);
      const rename = fs.renameSync;
      const failSave = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === info.infoFile) throw new Error("usage write fixture failure");
        return rename(from, to);
      });
      manager["sampleContextUsage"](live);
      expect(live.info.contextUsage).toBeUndefined();
      expect(manager.getAgentInfo("worker", parent).contextUsage).toBeUndefined();
      failSave.mockRestore();
      manager["sampleContextUsage"](live);
      expect(manager.getAgentInfo("worker", parent)).toMatchObject({ contextUsage: usage, status: before.status, messageCount: before.messageCount, lastActivity: before.lastActivity });
      const writes = spyOn(fs, "renameSync");
      manager["sampleContextUsage"](live);
      expect(writes).not.toHaveBeenCalled();
      writes.mockRestore();
      sample.mockReturnValue({ tokens: 1, contextWindow: 0, percent: 1 });
      manager["sampleContextUsage"](live);
      expect(manager.getAgentInfo("worker", parent).contextUsage).toBeUndefined();
      sample.mockReturnValue(usage);
      manager["live"].delete(info.id);
      manager["sampleContextUsage"](live);
      expect(manager.getAgentInfo("worker", parent).contextUsage).toBeUndefined();
      manager["live"].set(info.id, live);
      expect(errors.some((error) => error.message.includes("usage write fixture failure"))).toBe(true);
    } finally { await manager.shutdown(); }
  });

  test("one failed shutdown save still cleans every child and reports the original persistence error", async () => {
    const parent = "shutdown-save-" + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    let save: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "one", "hold first"));
      await manager.spawnAgent(spawnParams(parent, "two", "hold second"));
      await waitUntil(() => fixture.instances.every((instance) => instance.activeStreams === 1));
      const one = manager.getAgentInfo("one", parent);
      const rename = fs.renameSync;
      save = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === one.infoFile) throw new Error("shutdown save fixture failure");
        return rename(from, to);
      });
      await expect(manager.shutdown()).rejects.toThrow("shutdown save fixture failure");
      expect(manager["live"].size).toBe(0);
      expect(fixture.instances.map((instance) => instance.shutdowns)).toEqual([1, 1]);
      expect(fixture.instances.every((instance) => instance.activeStreams === 0)).toBe(true);
      expect(errors.some((error) => error.message.includes("shutdown save fixture failure"))).toBe(true);
    } finally { save?.mockRestore(); await manager.shutdown(); }
  });
});

describe("SDK acceptance and observer edge cases", () => {
  test.each(["completed", "failed", "interrupted"] as const)("a submitted but unaccepted prompt rejection restores the previous %s snapshot", async (status) => {
    const parent = "unaccepted-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    let prompt: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", status === "completed" ? "first" : status === "failed" ? "fail first" : "hold first"));
      if (status === "interrupted") await manager.interruptAgent(parent, "worker");
      const original = manager.getAgentInfo("worker", parent);
      await released(manager, original);
      const before = manager.getAgentInfo("worker", parent);
      const count = completions.length;
      // A small method spy covers native preflight rejection without a backend injection API.
      prompt = spyOn(codingAgent.AgentSession.prototype, "prompt").mockRejectedValueOnce(new Error("unaccepted prompt fixture rejection"));
      await expect(manager.sendMessage(parent, "worker", "not accepted")).rejects.toThrow("unaccepted prompt fixture rejection");
      await released(manager, before);
      const after = manager.getAgentInfo("worker", parent);
      expect(after).toMatchObject({ status, messageCount: before.messageCount, completedAt: before.completedAt, lastTaskMessage: before.lastTaskMessage });
      expect(after.finalResponse).toBe(before.finalResponse);
      expect(after.error).toBe(before.error);
      expect(completions).toHaveLength(count);
      expect(fixture.instances[1].requests).toEqual([]);
      expect(fixture.instances[1].shutdowns).toBe(1);
    } finally { prompt?.mockRestore(); await manager.shutdown(); }
  });

  test("a delayed unaccepted rejection cannot restore a completed snapshot over explicit interrupt", async () => {
    const gate = deferred();
    const parent = "reject-after-interrupt-" + randomUUID();
    const manager = new AgentManager();
    let prompt: ReturnType<typeof spyOn> | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      prompt = spyOn(codingAgent.AgentSession.prototype, "prompt").mockImplementationOnce(async () => {
        await gate.promise;
        throw new Error("late unaccepted fixture rejection");
      });
      pending = manager.sendMessage(parent, "worker", "not accepted").then(() => undefined, (error) => error);
      await waitUntil(() => Boolean(manager["live"].get(info.id)?.promptFinished));
      const interruption = manager.interruptAgent(parent, "worker");
      await waitUntil(() => manager.getAgentInfo("worker", parent).status === "interrupted");
      gate.resolve();
      await interruption;
      expect(await pending).toBeInstanceOf(Error);
      await released(manager, info);
      expect(manager.readAgentResponse("worker", parent)).toMatchObject({ status: "interrupted" });
      expect(manager.getAgentInfo("worker", parent).finalResponse).toBeUndefined();
      expect((await manager.waitAgent(parent, ["worker"])).event?.status).toBe("interrupted");
    } finally { gate.resolve(); await pending; prompt?.mockRestore(); await manager.shutdown(); }
  });

  test("a rejection after acceptance fails this run rather than restoring the previous answer", async () => {
    const gate = deferred();
    const parent = "accepted-rejection-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    let prompt: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      prompt = spyOn(codingAgent.AgentSession.prototype, "prompt").mockImplementationOnce(async (_text, options) => {
        options?.preflightResult?.("started");
        await gate.promise;
        throw new Error("accepted run fixture failure");
      });
      expect(await manager.sendMessage(parent, "worker", "accepted new task")).toEqual({ delivery: "prompt" });
      gate.resolve();
      await released(manager, info);
      expect(manager.getAgentInfo("worker", parent)).toMatchObject({ status: "failed", messageCount: 2, error: "accepted run fixture failure" });
      expect(manager.getAgentInfo("worker", parent).finalResponse).toBeUndefined();
      expect(completions).toHaveLength(2);
      expect(fixture.instances[1].shutdowns).toBe(1);
    } finally { gate.resolve(); prompt?.mockRestore(); await manager.shutdown(); }
  });

  test("settled.aborted without an assistant is a failed run, not the previous response", async () => {
    const parent = "settled-without-assistant-" + randomUUID();
    const manager = new AgentManager();
    let prompt: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      prompt = spyOn(codingAgent.AgentSession.prototype, "prompt").mockImplementationOnce(async (_text, options) => {
        options?.preflightResult?.("handled");
        await Promise.resolve(); // Let the caller install its original prompt Promise first.
        manager["handleSessionEvent"](manager["live"].get(info.id)!, { type: "agent_settled", aborted: true } as any);
      });
      await manager.sendMessage(parent, "worker", "handled aborted");
      await released(manager, info);
      expect(manager.getAgentInfo("worker", parent)).toMatchObject({ status: "failed", error: "Agent ended with aborted." });
      expect(manager.getAgentInfo("worker", parent).finalResponse).toBeUndefined();
      expect(fixture.instances[1].requests).toEqual([]);
    } finally { prompt?.mockRestore(); await manager.shutdown(); }
  });

  test("nested native tool activity is retained by the manager but filtered only from observer state", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = "nested-native-" + randomUUID();
    const completions: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => completions.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold nested"));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo("worker", parent);
      const live = manager["live"].get(info.id)!;
      for (const event of [
        { type: "tool_execution_start", args: {} },
        { type: "tool_execution_update", partialResult: { content: [{ type: "text", text: "nested progress" }] } },
        { type: "tool_execution_end", result: { content: [{ type: "text", text: "nested error" }] }, isError: true },
      ]) {
        live.lastActivityPersistedAt = 0;
        manager["handleSessionEvent"](live, { ...event, toolCallId: "parent/child", toolName: "read", parentToolCallId: "parent" } as any);
        expect(manager.getAgentInfo("worker", parent).lastActivity).toBe(live.info.lastActivity);
        expect(live.lastActivityPersistedAt).toBeGreaterThan(0);
      }
      const [sync] = await readSocketEvents(getSocketPath(info.id), 1);
      expect(sync.activeTools).toEqual([]);
      expect(completions).toEqual([]);
      gate.resolve();
      await released(manager, info);
      expect(completions).toEqual([expect.objectContaining({ status: "completed", finalResponse: "response:hold nested" })]);
      expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:hold nested");
      expect((await manager.waitAllAgents(parent, ["worker"])).responses).toEqual([expect.objectContaining({ status: "completed" })]);
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test("an uncooperative manager shutdown is bounded, refuses new work, and finishes late cleanup", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise, ignoreAbort: true });
    const parent = "uncooperative-shutdown-" + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold shutdown"));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo("worker", parent);
      const started = Date.now();
      await expect(manager.shutdown()).rejects.toThrow(/closing/);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(manager["live"].has(info.id)).toBe(true);
      expect(fs.existsSync(activeMarker(info.id))).toBe(true);
      await expect(manager.spawnAgent(spawnParams(parent, "late", "must not run"))).rejects.toThrow(/shut/);
      await expect(manager.sendMessage(parent, "worker", "must not run")).rejects.toThrow(/shut/);
      gate.resolve();
      await released(manager, info);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fixture.instances[0].activeStreams).toBe(0);
      expect(errors.length).toBeGreaterThan(0);
    } finally { gate.resolve(); await manager.shutdown(); }
  });

  test("an uncooperative extension shutdown still disposes once after its own finite deadline", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ shutdownGate: gate.promise });
    const original = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: any, delay: number, ...args: any[]) =>
      original(callback, delay === 5000 ? 100 : delay, ...args)) as typeof setTimeout);
    const parent = "shutdown-hook-timeout-" + randomUUID();
    const errors: Error[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      const info = manager.getAgentInfo("worker", parent);
      const live = manager["live"].get(info.id)!;
      const dispose = spyOn(live.session!, "dispose");
      await released(manager, info);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(errors.some((error) => error.message.includes("session_shutdown timed out"))).toBe(true);
      expect(manager.readAgentResponse("worker", parent).status).toBe("completed");
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
    } finally { timers.mockRestore(); gate.resolve(); await manager.shutdown(); }
  });
});

test("seven public tools carry native usage through metadata and the detail footer without consuming reads", async () => {
  codingAgent.initTheme("dark", false);
  fixture = configureCoreFixture({ tokens: (text) => text.includes("fourteen") ? 70000 : text.includes("twelve") ? 60000 : 50000 });
  const parent = "public-sdk-chain-" + randomUUID();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const sent: any[] = [];
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const ctx: any = {
    mode: "tui", cwd: TEST_AGENT_DIR, model: { provider: "test", id: "fake" },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "fake" }] },
    sessionManager: { getSessionId: () => parent },
    ui: { notify: mock(() => {}), setWidget() {} },
  };
  const { default: extension } = await import("../src/index.js");
  const execute = (name: string, params: any) => tools.get(name).execute("public-sdk-chain", params, undefined, undefined, ctx);
  const done = (percent: number) => waitUntil(() => getAgent("worker", parent)?.status === "completed" && getAgent("worker", parent)?.contextUsage?.tokens === percent * 5000);
  try {
    await extension({
      on(name: string, handler: any) { handlers.set(name, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      registerShortcut() {}, registerMessageRenderer() {}, sendMessage(message: any) { sent.push(message); },
      getThinkingLevel: () => "high", getActiveTools: () => ["read"],
      getSettings: () => ({ terminal: { showImages: false }, outputPad: 0 }),
    } as any);
    await handlers.get("session_start")({}, ctx);
    expect([...tools.keys()]).toEqual(["spawn_agent", "wait_agent", "wait_all_agents", "list_agents", "read_agent_response", "send_message", "interrupt_agent"]);
    expect((await execute("spawn_agent", { task_name: "worker", message: "sample ten" })).content[0].text).toBe("Spawned /worker.");
    await done(10);
    const beforeRead = sent.length;
    const read = await execute("read_agent_response", { target: "worker" });
    expect(read.content[0].text).toContain("response:sample ten");
    expect(await execute("read_agent_response", { target: "worker" })).toEqual(read);
    expect(sent).toHaveLength(beforeRead);
    expect((await execute("wait_agent", { targets: ["worker"] })).content[0].text).toContain("response:sample ten");
    expect((await execute("list_agents", {})).content[0].text).not.toContain("contextUsage");
    let detailOpened = 0;
    ctx.ui.custom = async (create: any) => {
      let component: any;
      let result: any;
      const frames: string[] = [];
      const tui = { terminal: { rows: 35 }, requestRender() {
        if (component instanceof SubagentPeekOverlay) frames.push(stripVTControlCharacters(component.render(80).join("\n")));
      } };
      component = create(tui, theme, {}, (value: any) => { result = value; component.dispose?.(); });
      try {
        if (component instanceof SubagentPeekOverlay) {
          detailOpened++;
          expect(component.render(80).at(-2)).toContain("│ 12%/500k │ ←/→ agent");
          expect((await execute("send_message", { target: "worker", message: "sample fourteen" })).details.delivery).toBe("prompt");
          await done(14);
          await waitUntil(() => frames.some((frame) => frame.includes("│ 14%/500k │ ←/→ agent")));
          component.handleInput("q");
        } else {
          expect(component.render(80).join("\n")).not.toMatch(/ctx |Context:|%\/500k/);
          expect((await execute("send_message", { target: "worker", message: "sample twelve" })).details.delivery).toBe("prompt");
          await done(12);
          component.handleInput("\r");
        }
        return result;
      } finally { component.dispose?.(); }
    };
    await commands.get("subagents").handler("", ctx);
    expect(detailOpened).toBe(1);
    expect((await execute("wait_all_agents", { targets: ["worker"] })).content[0].text).toContain("response:sample fourteen");
    const saved = getAgent("worker", parent)!;
    expect(saved.contextUsage).toMatchObject({ tokens: 70000, contextWindow: 500000 });
    expect(saved.contextUsage!.percent!).toBeCloseTo(14);
    const beforeHistory = fs.readFileSync(saved.sessionFile, "utf8");
    ctx.ui.custom = async (create: any) => {
      let component: any;
      let result: any;
      component = create({ terminal: { rows: 35 }, requestRender() {} }, theme, {}, (value: any) => { result = value; component.dispose?.(); });
      try {
        if (component instanceof SubagentPeekOverlay) {
          expect(component.render(80).at(-2)).toContain("│ 14%/500k │ ←/→ agent");
          component.handleInput("q");
        } else component.handleInput("\r");
        return result;
      } finally { component.dispose?.(); }
    };
    await commands.get("subagents").handler("", ctx);
    expect(fs.readFileSync(saved.sessionFile, "utf8")).toBe(beforeHistory);
    await execute("send_message", { target: "worker", message: "hold interrupt via tool" });
    expect((await execute("interrupt_agent", { target: "worker" })).details.previous_status).toBe("running");
    expect(getAgent("worker", parent)?.status).toBe("interrupted");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  } finally { await handlers.get("session_shutdown")?.(); }
});
describe("reviewed SDK lifecycle regressions", () => {
  test("a failed final save still publishes status, wakes wait_agent, and exposes consumed-mailbox/disk inconsistency", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = "failed-final-save-wait-" + randomUUID();
    const errors: Error[] = [];
    const activity: boolean[] = [];
    const notifications: any[] = [];
    const manager = new AgentManager({ onError: (error) => errors.push(error),
      onActivityChange: (event) => activity.push(event.active), onUnclaimedCompletion: (event) => notifications.push(event) });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    let save: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold final save"));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo("worker", parent);
      const rename = fs.renameSync;
      save = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === info.infoFile && JSON.parse(fs.readFileSync(String(from), "utf8")).status === "completed")
          throw new Error("final status fixture save failure");
        return rename(from, to);
      });
      const waiting = manager.waitAgent(parent, ["worker"], controller.signal);
      gate.resolve();
      expect((await waiting).event).toMatchObject({ status: "completed", finalResponse: "response:hold final save" });
      await released(manager, info);
      expect(activity.at(-1)).toBe(false);
      expect(notifications).toEqual([]);
      expect(errors.some((error) => error.message.includes("final status fixture save failure"))).toBe(true);
      expect(manager.getAgentInfo("worker", parent).status).toBe("running");
      expect(manager["live"].size).toBe(0);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      await expect(manager.waitAllAgents(parent, ["worker"], controller.signal)).rejects.toThrow(/persisted status|saved status|inconsistent/i);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally { clearTimeout(deadline); controller.abort(); save?.mockRestore(); gate.resolve(); await manager.shutdown(); }
  });

  test("wait_all_agents uses an existing terminal mailbox event ahead of a stale running disk record", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const parent = "failed-final-save-all-" + randomUUID();
    const notifications: any[] = [];
    const manager = new AgentManager({ onError() {}, onUnclaimedCompletion: (event) => notifications.push(event) });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    let save: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold mailbox final"));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo("worker", parent);
      const rename = fs.renameSync;
      save = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === info.infoFile && JSON.parse(fs.readFileSync(String(from), "utf8")).status === "completed")
          throw new Error("final status fixture save failure");
        return rename(from, to);
      });
      const waiting = manager.waitAllAgents(parent, ["worker"], controller.signal);
      gate.resolve();
      expect((await waiting).responses).toEqual([expect.objectContaining({ agent_name: "/worker", status: "completed", finalResponse: "response:hold mailbox final" })]);
      await released(manager, info);
      expect(notifications).toEqual([]);
      expect(manager.getAgentInfo("worker", parent).status).toBe("running");
      expect(manager["mailbox"].filter((event) => event.parentSessionId === parent)).toEqual([]);
    } finally { clearTimeout(deadline); controller.abort(); save?.mockRestore(); gate.resolve(); await manager.shutdown(); }
  });

  test("unaccepted resume rejection wakes a waiter registered during native input with the old final event, without renotifying", async () => {
    const gate = deferred();
    const parent = "resume-waiter-rollback-" + randomUUID();
    const notifications: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => notifications.push(event) });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    let resuming: Promise<unknown> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      const info = manager.getAgentInfo("worker", parent);
      await released(manager, info);
      expect(notifications).toHaveLength(1);
      fixture = configureCoreFixture({ input: async () => { await gate.promise; } });
      resuming = manager.sendMessage(parent, "worker", "not accepted").then(() => undefined, (error) => error);
      await waitUntil(() => fixture.instances[0]?.inputs.length === 1);
      const live = manager["live"].get(info.id)!;
      // Reject at the real native auth preflight AFTER input returns, without a backend stub.
      spyOn(live.session!.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
      spyOn(live.session!.modelRuntime, "checkAuth").mockResolvedValue(undefined);
      const waiting = manager.waitAgent(parent, ["worker"], controller.signal);
      expect(manager["waiters"]).toHaveLength(1);
      gate.resolve();
      const error = await resuming as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/API key|authentication/i);
      expect((await waiting).event).toMatchObject({ agentName: "/worker", status: "completed", finalResponse: "response:first" });
      await released(manager, info);
      expect(manager.getAgentInfo("worker", parent)).toMatchObject({ status: "completed", messageCount: 1, finalResponse: "response:first" });
      expect(notifications).toHaveLength(1);
      expect(fixture.instances[0].requests).toEqual([]);
      expect(fixture.instances[0].shutdowns).toBe(1);
    } finally { clearTimeout(deadline); controller.abort(); gate.resolve(); await resuming; await manager.shutdown(); }
  });

  describe("unaccepted resume completion state", () => {
    function rejectAfterInput(manager: InstanceType<typeof AgentManager>, info: AgentInfo, gate: ReturnType<typeof deferred>) {
      const entered = deferred();
      fixture = configureCoreFixture({ input: async () => {
        entered.resolve();
        await gate.promise;
        const session = manager["live"].get(info.id)!.session!;
        session.modelRuntime.unregisterProvider(info.provider);
        await session.modelRuntime.refresh({ allowNetwork: false });
        // unregister also starts a native background refresh, which may finish last.
        await waitUntil(() => !session.modelRuntime.hasConfiguredAuth(info.provider));
      } });
      const state = fixture;
      const resuming = manager.sendMessage(info.parentSessionId, info.taskName, "unaccepted native input")
        .then(() => undefined, (error) => error);
      return { entered: entered.promise, resuming, state };
    }

    test.each(["wait_agent", "wait_all_agents"])("commits rollback before an activity callback consumes it with %s", async (consumer) => {
      const gate = deferred();
      const parent = "rollback-activity-consumer-" + randomUUID();
      const notifications: any[] = [];
      let observeRollback = false;
      let callbackWait: Promise<any> | undefined;
      const manager = new AgentManager({
        onUnclaimedCompletion: (event) => notifications.push(event),
        onActivityChange(event) {
          if (!observeRollback || event.parentSessionId !== parent || event.active) return;
          callbackWait = consumer === "wait_agent"
            ? manager.waitAgent(parent, ["worker"])
            : manager.waitAllAgents(parent, ["worker"]);
        },
      });
      let resuming: Promise<unknown> | undefined;
      try {
        await manager.spawnAgent(spawnParams(parent, "worker", "first"));
        const info = manager.getAgentInfo("worker", parent);
        await released(manager, info);
        const original = manager["mailbox"].find((event) => event.agentName === "/worker")!;
        const rejected = rejectAfterInput(manager, info, gate);
        resuming = rejected.resuming;
        await rejected.entered;
        observeRollback = true;
        gate.resolve();
        expect(await resuming).toBeInstanceOf(Error);
        await released(manager, info);
        expect(callbackWait).toBeDefined();
        const result = await callbackWait;
        if (consumer === "wait_agent") expect(result.event).toMatchObject({ id: original.id, finalResponse: "response:first" });
        else expect(result.responses).toEqual([expect.objectContaining({ finalResponse: "response:first" })]);
        expect(manager["mailbox"]).toEqual([]);
        expect(manager["defaultWaitAllTargets"].get(parent)?.has("/worker") ?? false).toBe(false);
        expect(notifications).toHaveLength(1);
        expect(rejected.state.instances[0].requests).toEqual([]);
      } finally {
        observeRollback = false; gate.resolve(); await resuming; await callbackWait;
        await manager.shutdown();
      }
    });

    test.each(["wait_agent", "wait_all_agents"])("does not replay a completion already consumed by %s", async (consumer) => {
      const gate = deferred();
      const parent = "consumed-rollback-" + randomUUID();
      const notifications: any[] = [];
      const manager = new AgentManager({ onUnclaimedCompletion: (event) => notifications.push(event) });
      const controller = new AbortController();
      let resuming: Promise<unknown> | undefined;
      let waiting: Promise<any> | undefined;
      try {
        await manager.spawnAgent(spawnParams(parent, "worker", "first"));
        const info = manager.getAgentInfo("worker", parent);
        await released(manager, info);
        if (consumer === "wait_agent") await manager.waitAgent(parent, ["worker"]);
        else await manager.waitAllAgents(parent, ["worker"]);
        expect(manager["mailbox"]).toEqual([]);
        const rejected = rejectAfterInput(manager, info, gate);
        resuming = rejected.resuming;
        await rejected.entered;
        gate.resolve();
        expect(await resuming).toBeInstanceOf(Error);
        await released(manager, info);
        expect(rejected.state.instances[0].requests).toEqual([]);
        expect(manager["mailbox"]).toEqual([]);
        expect(manager["defaultWaitAllTargets"].get(parent)?.has("/worker") ?? false).toBe(false);
        expect((await manager.waitAllAgents(parent)).responses).toEqual([]);
        expect(notifications).toHaveLength(1);
        expect(manager.readAgentResponse("worker", parent).finalResponse).toBe("response:first");

        // A next-completion wait still belongs to the next accepted turn, not the old one.
        waiting = manager.waitAgent(parent, undefined, controller.signal);
        expect(manager["waiters"]).toHaveLength(1);
        fixture = configureCoreFixture();
        await manager.sendMessage(parent, "worker", "second");
        expect((await waiting).event).toMatchObject({ status: "completed", finalResponse: "response:second" });
        await released(manager, info);
        expect(notifications).toHaveLength(1);
      } finally {
        controller.abort(); gate.resolve(); await resuming; await waiting?.catch(() => {});
        await manager.shutdown();
      }
    });

    test("restores a targeted waiter without satisfying an unscoped next-completion waiter", async () => {
      const gate = deferred();
      const parent = "rollback-waiter-kinds-" + randomUUID();
      const manager = new AgentManager();
      const controller = new AbortController();
      let resuming: Promise<unknown> | undefined;
      let anyWait: Promise<any> | undefined;
      let targetedWait: Promise<any> | undefined;
      let anyResult: any;
      let targetedResult: any;
      try {
        await manager.spawnAgent(spawnParams(parent, "worker", "first"));
        const info = manager.getAgentInfo("worker", parent);
        await released(manager, info);
        await manager.waitAgent(parent, ["worker"]);
        const rejected = rejectAfterInput(manager, info, gate);
        resuming = rejected.resuming;
        await rejected.entered;
        anyWait = manager.waitAgent(parent, undefined, controller.signal)
          .then((result) => { anyResult = result; return result; }, (error) => error);
        targetedWait = manager.waitAgent(parent, ["worker"], controller.signal)
          .then((result) => { targetedResult = result; return result; }, (error) => error);
        expect(manager["waiters"]).toHaveLength(2);
        gate.resolve();
        expect(await resuming).toBeInstanceOf(Error);
        await released(manager, info);
        expect(anyResult).toBeUndefined();
        expect(targetedResult?.event).toMatchObject({ status: "completed", finalResponse: "response:first" });
        expect(manager["waiters"]).toHaveLength(1);
        expect(manager["mailbox"]).toEqual([]);
      } finally {
        controller.abort(); gate.resolve(); await resuming; await anyWait; await targetedWait;
        await manager.shutdown();
      }
    });

    test.each(["during input", "after rejection", "interrupt"])("preserves wait-all notification ownership: %s", async (phase) => {
      const responseA = deferred(), responseB = deferred(), input = deferred();
      const parent = "rollback-claims-" + randomUUID();
      const notifications: any[] = [];
      const manager = new AgentManager({ onUnclaimedCompletion: (event) => notifications.push(event) });
      const first = new AbortController(), second = new AbortController();
      let firstWait: Promise<any> | undefined, secondWait: Promise<any> | undefined;
      let resuming: Promise<unknown> | undefined;
      try {
        fixture = configureCoreFixture({ responseGate: responseA.promise });
        await manager.spawnAgent(spawnParams(parent, "a", "hold result A"));
        const infoA = manager.getAgentInfo("a", parent);
        fixture = configureCoreFixture({ responseGate: responseB.promise });
        await manager.spawnAgent(spawnParams(parent, "b", "hold result B"));
        firstWait = manager.waitAllAgents(parent, ["a", "b"], first.signal).catch((error) => error);
        secondWait = manager.waitAllAgents(parent, ["a", "b"], second.signal).catch((error) => error);
        responseA.resolve();
        await released(manager, infoA);
        const originalEvent = manager["mailbox"].find((event) => event.agentName === "/a")!;
        expect(originalEvent).toBeDefined();
        expect([...manager["waitAllClaims"]].every((claim) => claim.suppressedEventIds.has(originalEvent.id))).toBe(true);
        expect(notifications).toEqual([]);

        const rejected = rejectAfterInput(manager, infoA, input);
        resuming = rejected.resuming;
        await rejected.entered;
        first.abort(new Error("first claim canceled"));
        expect(await firstWait).toBeInstanceOf(Error);
        expect(notifications).toEqual([]); // The second claim still owns the notification.

        if (phase === "during input") {
          second.abort(new Error("last claim canceled during input"));
          expect(await secondWait).toBeInstanceOf(Error);
          expect(notifications).toEqual([expect.objectContaining({ id: originalEvent.id, agentName: "/a" })]);
        }
        if (phase === "interrupt") {
          const interrupting = manager.interruptAgent(parent, "a");
          await waitUntil(() => manager.getAgentInfo("a", parent).status === "interrupted");
          input.resolve();
          await interrupting;
        } else input.resolve();
        expect(await resuming).toBeInstanceOf(Error);
        await released(manager, infoA);

        const currentEvent = manager["mailbox"].find((event) => event.agentName === "/a")!;
        if (phase === "interrupt") {
          expect(currentEvent).toMatchObject({ status: "interrupted" });
          expect(currentEvent.id).not.toBe(originalEvent.id);
        } else {
          expect(currentEvent).toBe(originalEvent);
          expect(rejected.state.instances[0].requests).toEqual([]);
        }
        if (phase !== "during input") {
          second.abort(new Error("last claim canceled"));
          expect(await secondWait).toBeInstanceOf(Error);
        }
        expect(notifications).toEqual(phase === "interrupt" ? [] : [
          expect.objectContaining({ id: originalEvent.id, agentName: "/a", finalResponse: "response:hold result A" }),
        ]);
      } finally {
        first.abort(); second.abort(); input.resolve(); responseA.resolve(); responseB.resolve();
        await resuming; await firstWait; await secondWait; await manager.shutdown();
      }
    });
  });

  test.each(["before", "after"])("a compaction-only busy session cannot report steer acceptance (%s await)", async (phase) => {
    const gate = deferred();
    const parent = "compaction-only-steer-" + phase + "-" + randomUUID();
    const manager = new AgentManager();
    let session: any;
    let steer: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold run"));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo("worker", parent);
      session = manager["live"].get(info.id)!.session!;
      const compactionOnly = () => {
        // Public state getters reproduce the native manual-compaction-only gap:
        // not idle does NOT imply an agent stream to which steering can be delivered.
        Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
        Object.defineProperty(session, "isIdle", { configurable: true, get: () => false });
      };
      if (phase === "before") {
        compactionOnly();
        steer = spyOn(session, "steer");
        await expect(manager.sendMessage(parent, "worker", "must not queue")).rejects.toThrow(/finishing|stream|running|delivery/i);
        expect(steer).not.toHaveBeenCalled();
      } else {
        steer = spyOn(session, "steer").mockImplementation(async () => { await gate.promise; compactionOnly(); return "queued"; });
        const pending = manager.sendMessage(parent, "worker", "must not claim delivery").then(() => undefined, (error) => error);
        await waitUntil(() => manager["live"].get(info.id)!.pendingSteers.size === 1);
        gate.resolve();
        expect(await pending).toBeInstanceOf(Error);
        expect(manager.getAgentInfo("worker", parent).lastTaskMessage).toBe("hold run");
      }
      expect(fixture.instances).toHaveLength(1);
    } finally {
      gate.resolve(); steer?.mockRestore();
      if (session) { delete session.isStreaming; delete session.isIdle; }
      await manager.shutdown();
    }
  });

  test("an extension recovery after an aborted settled boundary uses the final successful settled result", async () => {
    let recovered = false;
    fixture = configureCoreFixture({ onSettled(aborted, pi) {
      if (aborted && !recovered) {
        recovered = true;
        pi.sendUserMessage("recovered successfully");
      }
    } });
    const parent = "aborted-settled-recovery-" + randomUUID();
    const notifications: any[] = [];
    const manager = new AgentManager({ onUnclaimedCompletion: (event) => notifications.push(event) });
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold original"));
      await waitUntil(() => fixture.instances[0].activeStreams === 1);
      const info = manager.getAgentInfo("worker", parent);
      const session = manager["live"].get(info.id)!.session!;
      // Only abort native work: manager interrupt would intentionally own the terminal status.
      await session.abort();
      await released(manager, info);
      expect(fixture.instances[0].events.filter((event) => event.startsWith("settled:"))).toEqual(["settled:aborted", "settled:success"]);
      expect(manager.readAgentResponse("worker", parent)).toMatchObject({ status: "completed", finalResponse: "response:recovered successfully" });
      expect(notifications).toEqual([expect.objectContaining({ status: "completed", finalResponse: "response:recovered successfully" })]);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(fixture.instances[0].requests.map((request) => request.text)).toEqual(["hold original", "recovered successfully"]);
    } finally { await manager.shutdown(); }
  });
});

describe("SDK cleanup ownership regressions", () => {
  // Keep every logger stream, including any orphan no longer reachable through logger.stream.
  function trackLogStreams() {
    const streams: fs.WriteStream[] = [];
    const create = fs.createWriteStream;
    const spy = spyOn(fs, "createWriteStream").mockImplementation((file, options) => {
      const stream = create(file, options);
      if (String(file).endsWith(".log")) streams.push(stream);
      return stream;
    });
    return {
      streams,
      async cleanup() {
        try {
          for (const stream of streams) {
            if (stream.closed) continue;
            const closed = once(stream, "close");
            stream.destroy();
            await closed.catch(() => {});
          }
        } finally { spy.mockRestore(); }
      },
    };
  }

  test("R1: startup abort reentry owns one cleanup chain until idempotent extension shutdown releases", async () => {
    const failStartup = deferred();
    const shutdownGate = deferred();
    const tracked = trackLogStreams();
    const parent = "reentrant-cleanup-owner-" + randomUUID();
    const manager = new AgentManager({ onError() {} });
    let timer: ReturnType<typeof setInterval> | undefined;
    let armed = false;
    let registeredBeforeAbort = false;
    let closing = false;
    let activeResources = 0;
    let freedResources = 0;
    let startupFailure: unknown;
    let pending: Promise<unknown> | undefined;
    let termination: Promise<void> | undefined;
    let dispose: ReturnType<typeof spyOn> | undefined;
    const firstFixture = fixture = configureCoreFixture({
      async onStart(pi, ctx) {
        timer = setInterval(() => {}, 1000);
        activeResources++;
        // Real extension-owned work creates the native signal during session_start.
        pi.sendUserMessage("hold startup-owned work");
        await waitUntil(() => Boolean(ctx.signal), 2000);
        ctx.signal!.addEventListener("abort", () => {
          registeredBeforeAbort = Boolean([...manager["live"].values()][0]?.termination);
          ctx.shutdown(); // Native abort listeners run synchronously, reentering termination.
        }, { once: true });
        armed = true;
        await failStartup.promise;
        throw new Error("cleanup ownership startup failure");
      },
      async onShutdown() {
        // A conventional idempotent hook: a second invocation returns while the first waits.
        if (closing) return;
        closing = true;
        await shutdownGate.promise;
        clearInterval(timer);
        activeResources--;
        freedResources++;
      },
    });
    try {
      pending = manager.spawnAgent(spawnParams(parent, "worker", "not yet submitted")).catch((error) => {
        startupFailure = error;
        return error;
      });
      await waitUntil(() => startupFailure !== undefined || (armed && firstFixture.instances[0]?.activeStreams === 1), 2000);
      if (startupFailure !== undefined) throw startupFailure;
      const info = manager.getAgentInfo("worker", parent);
      const live = manager["live"].get(info.id)!;
      dispose = spyOn(live.session!, "dispose");
      failStartup.resolve();
      await waitUntil(() => firstFixture.instances[0].shutdowns > 0);
      termination = live.termination;
      expect({
        registeredBeforeAbort,
        shutdowns: firstFixture.instances[0].shutdowns,
        disposals: dispose.mock.calls.length,
        liveRetained: manager["live"].get(info.id) === live,
        markerRetained: fs.existsSync(activeMarker(info.id)),
        activeResources,
        freedResources,
      }).toEqual({
        registeredBeforeAbort: true, shutdowns: 1, disposals: 0,
        liveRetained: true, markerRetained: true, activeResources: 1, freedResources: 0,
      });
      expect(manager["terminateSession"](live)).toBe(termination);
      await expect(manager.sendMessage(parent, "worker", "must not reopen the JSONL")).rejects.toThrow(/closing|finishing/i);
      expect(firstFixture.instances).toHaveLength(1);

      shutdownGate.resolve();
      const error = await pending as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("cleanup ownership startup failure");
      await released(manager, info);
      expect(firstFixture.instances[0].shutdowns).toBe(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect([activeResources, freedResources]).toEqual([0, 1]);
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);

      fixture = configureCoreFixture();
      await manager.sendMessage(parent, "worker", "reopen only after actual cleanup");
      await released(manager, info);
      expect(manager.getAgentInfo("worker", parent).sessionFile).toBe(info.sessionFile);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      failStartup.resolve(); shutdownGate.resolve(); clearInterval(timer);
      try {
        await pending;
        await termination?.catch(() => {});
        await manager.shutdown();
      } finally { dispose?.mockRestore(); await tracked.cleanup(); }
    }
  });

  test("R3: logging works while closing, but a closed logger stays inert when a new session appends", async () => {
    const responseGate = deferred();
    const shutdownGate = deferred();
    fixture = configureCoreFixture({ responseGate: responseGate.promise, shutdownGate: shutdownGate.promise });
    const tracked = trackLogStreams();
    const parent = "logger-close-owner-" + randomUUID();
    const manager = new AgentManager();
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold logger run"));
      const info = manager.getAgentInfo("worker", parent);
      const live = manager["live"].get(info.id)!;
      live.logger.info("regression", "normal write");
      expect(tracked.streams).toHaveLength(1);
      const original = tracked.streams[0];

      responseGate.resolve();
      await waitUntil(() => fixture.instances[0].shutdowns === 1);
      expect(live.closing).toBe(true);
      expect(original.writableEnded).toBe(false);
      live.logger.info("regression", "closing write");
      expect(tracked.streams).toHaveLength(1);
      shutdownGate.resolve();
      await released(manager, info);
      await waitUntil(() => original.closed);
      live.logger.close();
      live.logger.close();
      const mkdir = spyOn(fs, "mkdirSync");
      let mkdirCalls = -1;
      try {
        live.logger.info("regression", "must not write after close");
        mkdirCalls = mkdir.mock.calls.length;
      } finally { mkdir.mockRestore(); }

      fixture = configureCoreFixture();
      await manager.sendMessage(parent, "worker", "hold restored logger");
      const restored = manager["live"].get(info.id)!;
      expect(restored.logger).not.toBe(live.logger);
      restored.logger.info("regression", "restored append");
      const restoredStream = tracked.streams.at(-1)!;
      await manager.interruptAgent(parent, "worker");
      await released(manager, info);
      await waitUntil(() => restoredStream.closed);
      expect(mkdirCalls).toBe(0);
      expect(tracked.streams).toHaveLength(2);
      expect(tracked.streams.every((stream) => stream.closed)).toBe(true);
      const messages = fs.readFileSync(info.logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .filter((entry) => entry.category === "regression").map((entry) => entry.message);
      expect(messages).toEqual(["normal write", "closing write", "restored append"]);
    } finally {
      responseGate.resolve(); shutdownGate.resolve();
      try { await manager.shutdown(); } finally { await tracked.cleanup(); }
    }
  });

  test("R3: repeated close before the first write cannot mkdir or create a stream", async () => {
    const gate = deferred();
    fixture = configureCoreFixture({ responseGate: gate.promise });
    const tracked = trackLogStreams();
    const manager = new AgentManager();
    const parent = "logger-never-opened-" + randomUUID();
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "hold never logged"));
      const info = manager.getAgentInfo("worker", parent);
      const logger = manager["live"].get(info.id)!.logger;
      expect(tracked.streams).toHaveLength(0);
      logger.close();
      logger.close();
      const mkdir = spyOn(fs, "mkdirSync");
      try {
        logger.info("regression", "must stay unopened");
        expect(mkdir).not.toHaveBeenCalled();
        expect(tracked.streams).toHaveLength(0);
        expect(logger["stream"]).toBeNull();
      } finally { mkdir.mockRestore(); }
    } finally {
      gate.resolve();
      try { await manager.shutdown(); } finally { await tracked.cleanup(); }
    }
  });

  test.each(["onError", "console"] as const)("R3: shutdown timeout and late hook errors reach %s without reopening any log stream", async (sink) => {
    const gate = deferred();
    const lateError = "late cleanup hook failure " + sink;
    fixture = configureCoreFixture({ shutdownGate: gate.promise, onShutdown() { throw new Error(lateError); } });
    const tracked = trackLogStreams();
    const hostErrors: string[] = [];
    const consoleSpy = sink === "console" ? spyOn(console, "error").mockImplementation((...args: any[]) => {
      hostErrors.push(args.join(" "));
    }) : undefined;
    const originalTimeout = globalThis.setTimeout;
    // Accelerate only the existing shutdown hook deadline; no production injection interface.
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: any, ms: number, ...args: any[]) =>
      originalTimeout(callback, ms === 5000 ? 100 : ms, ...args)) as typeof setTimeout);
    const manager = new AgentManager(sink === "onError" ? { onError: (error) => hostErrors.push(error.message) } : {});
    const parent = "logger-late-cleanup-" + randomUUID();
    let dispose: ReturnType<typeof spyOn> | undefined;
    try {
      await manager.spawnAgent(spawnParams(parent, "worker", "first"));
      const info = manager.getAgentInfo("worker", parent);
      const live = manager["live"].get(info.id)!;
      dispose = spyOn(live.session!, "dispose");
      live.logger.info("regression", "before shutdown deadline");
      expect(tracked.streams).toHaveLength(1);
      const original = tracked.streams[0];
      await waitUntil(() => fixture.instances[0].shutdowns === 1);
      await released(manager, info);
      await waitUntil(() => hostErrors.some((message) => message.includes("session_shutdown timed out")));
      gate.resolve();
      await waitUntil(() => hostErrors.some((message) => message.includes(lateError)));
      await waitUntil(() => original.closed);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(fixture.instances[0].shutdowns).toBe(1);
      expect(manager.readAgentResponse("worker", parent).status).toBe("completed");
      expect(fs.existsSync(activeMarker(info.id))).toBe(false);
      expect({
        createdStreams: tracked.streams.length,
        openStreams: tracked.streams.filter((stream) => !stream.closed).length,
        loggerRetainsStream: live.logger["stream"] !== null,
      }).toEqual({ createdStreams: 1, openStreams: 0, loggerRetainsStream: false });
    } finally {
      gate.resolve();
      try { await manager.shutdown(); } finally {
        dispose?.mockRestore(); timers.mockRestore(); consoleSpy?.mockRestore();
        await tracked.cleanup();
      }
    }
  });
});
