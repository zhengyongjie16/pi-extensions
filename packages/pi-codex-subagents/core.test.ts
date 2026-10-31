import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";
import type { AgentInfo } from "./core.js";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

// macOS os.tmpdir() can be too long for a Unix socket address; keep the POSIX root short.
const TEST_AGENT_DIR = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "ps-"));
const FAKE_RPC_CHILD = path.join(import.meta.dir, "test", "fake-rpc-child.js");
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
  getAgent,
  getRunsDir,
  getSocketPath,
  loadSubagentConfig,
  parentScopeKey,
  parseAgentDefinitionText,
  taskStorageKey,
} = await import("./core.js");
const { formatAgentSpecLines, SubagentPeekOverlay } = await import("./peek.js");


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
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
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
  test("explains quota errors that Node leaves unnamed", () => {
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
      // No level requested anywhere, not even by the parent, falls back to the package default.
      await manager.spawnAgent(spawnParams(parentSessionId, "default-thinking", "work"));
      expect(manager.getAgentInfo("default-thinking", parentSessionId)).toMatchObject({ model: "test:fake", thinking: "high" });
      await expect(spawn("missing", { agent_type: "absent" })).rejects.toThrow("Agent template not found");
    } finally {
      await manager.shutdown();
      fs.rmSync(templateFile, { force: true });
      delete process.env.PI_SUBAGENT_PI_BIN;
    }
  });
});

describe("child process lifecycle", () => {
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
    const socketDir = path.dirname(getSocketPath("11111111-1111-4111-8111-111111111111"));
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

  test("accepts Darwin process ownership when ps cannot expose the token", async () => {
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
    const reconcilers: AgentManager[] = [];
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
          expect(menu.render(80).join("\n")).toContain("Subagents");
          menusOpened++;
          return undefined;
        },
      },
    };
    const { default: subagentExtension } = await import("./index.js");
    try {
      subagentExtension({
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
    // A thinking suffix on an allowlist entry is tolerated and stripped from the offered pair.
    fs.writeFileSync(configFile, JSON.stringify({ models: ["test/fake:high", "typo/nope"], modelsFromEnabledModels: true }));
    const { default: subagentExtension } = await import("./index.js");
    subagentExtension(pi);
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
      let browser: any;
      ctx.ui.custom = async (create: any) => {
        browser = create({ requestRender() {} }, {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        }, {}, () => {});
        return undefined;
      };
      await commands.get("subagents").handler("", ctx);
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
    } finally {
      await emit("session_shutdown", { reason: "quit" });
      fs.rmSync(scope, { recursive: true, force: true });
      fs.rmSync(configFile, { force: true });
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
  const textResult = (text: string) => ({ content: [{ type: "text", text }], details: {} });
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

  test.each([false, true])("retains a finished parent's result until its toolResult message (isError=%s)", async (isError) => {
    const result = { ...textResult("final script output"), details: { calls: [], elapsed: 42 } };
    const inputs = [start("parent"), end("parent", result, isError)] as const;
    const original = JSON.stringify(inputs);
    emit(...inputs);
    expect((await snapshot()).activeTools).toEqual([{
      toolCallId: "parent", toolName: "codemode", args: inputs[0].args, result, isError,
    }]);
    // message_end is the existing event handoff, not a disk-write acknowledgement.
    emit(messageEnd("parent"));
    expect((await snapshot()).activeTools).toEqual([]);
    expect(await flush()).toEqual([...inputs, messageEnd("parent")]);
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
      end("parent", textResult("Operation failed"), true),
      { type: "message_end", message: { role: "assistant", content: [], stopReason, errorMessage: "Operation failed" } },
      { type: "agent_end", messages: [] },
    ];
    emit(...values);
    expect((await snapshot()).activeTools).toHaveLength(1);
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
      } as any, { fg: (_color: string, text: string) => text } as any, info, (value) => navigation.push(value));
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
      update("script", textResult("parent progress")));
    await waitUntil(() => render(overlay).includes("parent progress"));
    expect(tools(overlay)).toHaveLength(1);
    expect(overlay["pendingTools"].has("script/1")).toBe(false);
    expect(overlay["pendingTools"].has("script/2")).toBe(false);

    overlay.dispose();
    overlay = await open();
    expect(tools(overlay)).toHaveLength(1);
    expect(render(overlay)).toContain("parent progress");
    const result = textResult("final script output");
    emit(nested(end("script/1", textResult("nested file")), "script"),
      nested(end("script/2", textResult("nested shell")), "script"),
      end("script", result));
    await waitUntil(() => render(overlay).includes("final script output"));
    overlay.dispose();
    overlay = await open();
    expect(tools(overlay)).toHaveLength(1);
    expect(render(overlay)).toContain("final script output");

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
