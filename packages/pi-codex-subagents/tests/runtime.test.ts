import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { ChildSessionOptions } from "../src/runtime.ts";
import type { OfflineFixtureConfig } from "./fixtures/sdk-offline-extension.ts";

const testFile = fileURLToPath(import.meta.url);
// Isolate SDK contracts from sibling suites' environment changes and shared-method spies:
// both Bun and Node must load the REAL SDK, with no host credentials or network requests.
if (process.env.PI_SUBAGENT_SDK_CONTRACT_CHILD !== "1") {
  test("real Pi SDK 1.5 offline contracts (isolated from core module mocks)", () => {
    const args = process.versions.bun ? ["test", testFile, "--timeout", "60000"] : ["--test", testFile];
    const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT_SDK_CONTRACT_CHILD: "1" };
    // Node forwards this marker to children; retaining it makes --test skip the nested suite.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, args, {
      env,
      encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    assert.ifError(result.error);
    assert.equal(result.status, 0, output);
    assert.match(output, /explicit SYSTEM\/skills\/extensions only/, "child must execute the real suite, not silently skip it");
    console.log(output.trim());
  });
} else {
  test("contracts run against the supported Pi SDK 1.5.0, not a stale development dependency", () => {
    const manifest = new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
    assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).version, "1.5.0");
  });
  const originalFetch = globalThis.fetch;
  const fetchAttempts: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    fetchAttempts.push(String(input));
    throw new Error("Network is forbidden in offline SDK contracts: " + String(input));
  }) as typeof fetch;
  after(() => {
    globalThis.fetch = originalFetch;
    assert.deepEqual(fetchAttempts, [], "SDK contracts must not even attempt a fetch");
  });

  const { createChildSession, promptChildSession, shutdownChildSession } = await import("../src/runtime.ts");
  const { CONFIG_DIR_NAME, getAgentDir, ProjectTrustStore, SessionManager, createAgentSessionServices, createAgentSessionFromServices, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const fixtureSource = fileURLToPath(new URL("./fixtures/sdk-offline-extension.ts", import.meta.url));
  type EventRecord = { type: string; [key: string]: any };
  type Disposition = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];
  const baseSettings = {
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    enableAnalytics: false, enableInstallTelemetry: false, defaultProjectTrust: "ask",
    defaultProvider: "parent-default", defaultModel: "must-not-change", defaultThinkingLevel: "low",
  };
  function write(file: string, contents: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  function json(file: string, value: unknown): void { write(file, JSON.stringify(value)); }
  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  interface Fixture {
    root: string;
    agentDir: string;
    cwd: string;
    extensionDir: string;
    extensionPath: string;
    systemPromptPath: string;
    info: ChildSessionOptions["info"];
    errors: unknown[];
    logs: string[];
    sessions: Set<AgentSession>;
    create(overrides?: Partial<ChildSessionOptions>): Promise<AgentSession>;
    close(session: AgentSession, timeoutMs?: number): Promise<void>;
    configure(config: OfflineFixtureConfig): void;
    events(): EventRecord[];
    waitFor(type: string, predicate?: (event: EventRecord) => boolean): Promise<EventRecord>;
    release(name: string): void;
  }
  async function withFixture(config: OfflineFixtureConfig, run: (fixture: Fixture) => Promise<void>): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-contract-"));
    const agentDir = path.join(root, "user");
    const cwd = path.join(root, "work", "project");
    const extensionDir = path.join(root, "explicit-extension");
    const extensionPath = path.join(extensionDir, "index.ts");
    const systemPromptPath = path.join(root, "child-SYSTEM.md");
    const configPath = path.join(extensionDir, "sdk-fixture.json");
    const eventsPath = path.join(extensionDir, "sdk-events.jsonl");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const sessions = new Set<AgentSession>();
    const pending: Promise<AgentSession>[] = [];
    const errors: unknown[] = [];
    const logs: string[] = [];
    const info = {
      cwd, sessionFile: path.join(root, "subagents", "child.jsonl"),
      provider: config.provider ?? "sdk-offline", modelId: config.modelId ?? "exact/model",
      extensionPaths: [extensionPath],
    };
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.dirname(info.sessionFile), { recursive: true });
    write(extensionPath, fs.readFileSync(fixtureSource, "utf8"));
    json(configPath, config);
    json(path.join(agentDir, "settings.json"), baseSettings);
    json(path.join(agentDir, "auth.json"), {});
    json(path.join(agentDir, "models.json"), { providers: {} });
    write(systemPromptPath, "CHILD_EXPLICIT_SYSTEM");
    const f: Fixture = {
      root, agentDir, cwd, extensionDir, extensionPath, systemPromptPath, info, errors, logs, sessions,
      create(overrides = {}) {
        assert.equal(getAgentDir(), agentDir, "must use the unmocked SDK and isolated agentDir");
        const promise = createChildSession({
          info, systemPromptPath, checkCanceled() {}, onError: (error) => { errors.push(error); },
          onShutdown() {}, log: (message) => { logs.push(message); }, ...overrides,
          onCreated(session) { sessions.add(session); overrides.onCreated?.(session); },
        });
        pending.push(promise);
        void promise.catch(() => {});
        return promise;
      },
      async close(session, timeoutMs) {
        try { await shutdownChildSession(session, timeoutMs); }
        finally { sessions.delete(session); }
      },
      configure(config) { json(configPath, config); },
      events() { return fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : []; },
      async waitFor(type, predicate = () => true) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const event = f.events().find((event) => event.type === type && predicate(event));
          if (event) return event;
          await delay(5);
        }
        throw new Error("Fixture event not observed: " + type + " " + JSON.stringify(f.events()));
      },
      release(name) { write(path.join(extensionDir, "release-" + name), "release"); },
    };
    try { await run(f); }
    finally {
      for (const name of ["factory", "startup", "response", "input", "shutdown"]) f.release(name);
      await Promise.allSettled(pending);
      await Promise.allSettled([...sessions].map(async (session) => {
        try { await session.abort(); await session.waitForIdle(); }
        finally { await f.close(session, 1_000); }
      }));
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  function assistants(session: AgentSession) {
    return session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant");
  }
  async function prompt(session: AgentSession, message: string): Promise<Disposition[]> {
    const accepted: Disposition[] = [];
    await promptChildSession(session, message, (disposition) => { accepted.push(disposition); });
    await session.waitForIdle();
    return accepted;
  }

  test("explicit SYSTEM/skills/extensions only; no global, ancestor or project discovery", async () => withFixture({}, async (f) => {
    const marker = "FORBIDDEN_DEFAULT_RESOURCE";
    for (const dir of [f.agentDir, path.dirname(f.cwd), f.cwd, path.join(f.cwd, CONFIG_DIR_NAME)]) {
      for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md", "AGENTS.md", "AGENTS.override.md", "CLAUDE.md"]) write(path.join(dir, name), marker);
    }
    for (const dir of [f.agentDir, path.join(f.cwd, CONFIG_DIR_NAME)]) {
      write(path.join(dir, "skills", "default-skill", "SKILL.md"), "---\nname: default-skill\ndescription: " + marker + "\n---\nDefault body");
      write(path.join(dir, "prompts", "default-template.md"), marker);
      write(path.join(dir, "extensions", "default.ts"), 'export default () => { throw new Error("default extension must not load"); };');
    }
    write(path.join(path.dirname(f.cwd), ".agents", "skills", "ancestor-skill", "SKILL.md"), "---\nname: ancestor-skill\ndescription: " + marker + "\n---\nBody");
    const skillPath = path.join(f.root, "chosen-skill", "SKILL.md");
    write(skillPath, "---\nname: chosen-skill\ndescription: EXPLICIT_SKILL_DESCRIPTION\n---\nEXPLICIT_SKILL_BODY");
    const session = await f.create({ projectTrusted: true, info: { ...f.info, skillPaths: [skillPath] } });
    assert.deepEqual(session.messages, []);
    assert.match(session.systemPrompt, /CHILD_EXPLICIT_SYSTEM/);
    assert.match(session.systemPrompt, /EXPLICIT_SKILL_DESCRIPTION/);
    assert.doesNotMatch(session.systemPrompt, /FORBIDDEN_DEFAULT_RESOURCE|EXPLICIT_SKILL_BODY/);
    assert.deepEqual(session.resourceLoader.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(session.resourceLoader.getAppendSystemPrompt(), []);
    assert.deepEqual(session.resourceLoader.getPrompts().prompts, []);
    assert.deepEqual(session.resourceLoader.getThemes().themes, []);
    assert.deepEqual(session.resourceLoader.getSkills().skills.map((skill) => skill.name), ["chosen-skill"]);
    await prompt(session, "Template body still belongs in the first user message");
    const request = f.events().find((event) => event.type === "request")!;
    assert.deepEqual(request.userTexts, ["Template body still belongs in the first user message"]);
    assert.doesNotMatch(request.systemPrompt, /FORBIDDEN_DEFAULT_RESOURCE/);
    assert.deepEqual(f.errors, []);
  }));

  test("SYSTEM file whose text is another path is read once, not reinterpreted", async () => withFixture({}, async (f) => {
    const target = path.join(f.root, "must-not-read.md");
    write(target, "UNEXPECTED_SECOND_READ");
    write(f.systemPromptPath, target);
    const session = await f.create();
    assert.equal(session.resourceLoader.getSystemPrompt(), target);
    assert.equal(session.resourceLoader.getSystemPromptSource()?.path, f.systemPromptPath);
    assert.ok(session.systemPrompt.includes(target));
    assert.doesNotMatch(session.systemPrompt, /UNEXPECTED_SECOND_READ/);
  }));

  test("missing or BOM/whitespace-only SYSTEM fails before extension loading", async () => withFixture({}, async (f) => {
    write(f.systemPromptPath, "\uFEFF \n ");
    await assert.rejects(f.create(), /System prompt is empty/);
    fs.unlinkSync(f.systemPromptPath);
    await assert.rejects(f.create(), /ENOENT/);
    assert.deepEqual(f.events(), []);
    assert.equal(f.sessions.size, 0);
  }));

  test("tools retain undefined / allowlist / no-builtin tri-state; SDK does not load CLI builtins", async () => withFixture({}, async (f) => {
    for (const tools of [undefined, "read", ""]) {
      const session = await f.create({ info: { ...f.info, tools, sessionFile: path.join(f.root, "subagents", "tools-" + String(tools) + ".jsonl") } });
      const active = session.getActiveToolNames();
      if (tools === undefined) { assert.ok(active.includes("read")); assert.ok(active.includes("fixture_tool")); }
      else if (tools === "read") assert.deepEqual(active, ["read"]);
      else assert.deepEqual(active, ["fixture_tool"]);
      assert.ok(!session.getAllTools().some((tool) => ["codemode", "tool_search"].includes(tool.name)));
      await f.close(session);
    }
  }));

  test("explicit effective trust overrides saved decisions and gates project settings everywhere", async () => withFixture({}, async (f) => {
    const store = new ProjectTrustStore(f.agentDir);
    json(path.join(f.cwd, CONFIG_DIR_NAME, "settings.json"), { defaultTools: ["fixture_tool"], defaultProvider: "project-default" });
    for (const trusted of [false, true]) {
      store.set(f.cwd, !trusted);
      const session = await f.create({ projectTrusted: trusted });
      assert.equal(session.settingsManager.isProjectTrusted(), trusted);
      assert.equal(session.extensionRunner.createContext().isProjectTrusted(), trusted);
      assert.equal(f.events().filter((event) => event.type === "session_start").at(-1)!.trusted, trusted);
      assert.equal(session.settingsManager.getDefaultProvider(), trusted ? "project-default" : "parent-default");
      assert.equal(session.getActiveToolNames().includes("read"), !trusted);
      await f.close(session);
    }
  }));

  test("headless trust uses child cwd, global policy and native store; unknown ask/never stay closed", async () => withFixture({}, async (f) => {
    json(path.join(f.cwd, CONFIG_DIR_NAME, "settings.json"), { defaultProjectTrust: "always", defaultProvider: "project-default" });
    const store = new ProjectTrustStore(f.agentDir);
    // A different parent's trusted cwd must not authorize this sibling project.
    store.set(path.join(f.root, "other-parent-cwd"), true);
    for (const policy of ["ask", "never", "always"]) {
      json(path.join(f.agentDir, "settings.json"), { ...baseSettings, defaultProjectTrust: policy });
      const session = await f.create();
      assert.equal(session.settingsManager.isProjectTrusted(), policy === "always");
      assert.equal(store.get(f.cwd), null, "headless fallback must not save a new authorization");
      await f.close(session);
    }
    for (const saved of [false, true]) {
      store.set(f.cwd, saved);
      const session = await f.create();
      assert.equal(session.settingsManager.isProjectTrusted(), saved);
      await f.close(session);
    }
  }));

  test("restoring rereads settings/current trust and never persists child route/thinking as defaults", async () => withFixture({}, async (f) => {
    json(path.join(f.cwd, CONFIG_DIR_NAME, "settings.json"), { defaultProvider: "project-one" });
    const globalSettingsPath = path.join(f.agentDir, "settings.json");
    const original = fs.readFileSync(globalSettingsPath, "utf8");
    const first = await f.create({ projectTrusted: true, info: { ...f.info, thinking: "high" } });
    assert.equal(first.thinkingLevel, "off", "SDK clamps unsupported thinking");
    await prompt(first, "first child message");
    await first.setModel(first.modelRuntime.getModel(f.info.provider, "other-model")!);
    first.setThinkingLevel("high");
    await first.settingsManager.flush();
    await f.close(first);
    json(path.join(f.cwd, CONFIG_DIR_NAME, "settings.json"), { defaultProvider: "project-two" });
    const second = await f.create({ projectTrusted: false });
    assert.equal(second.settingsManager.getDefaultProvider(), "parent-default");
    assert.equal(second.model?.id, f.info.modelId, "saved info route wins over historical/model defaults");
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(assistants(second).length, 1);
    assert.notEqual(second.modelRuntime, first.modelRuntime);
    assert.notEqual(second.settingsManager, first.settingsManager);
    assert.notEqual(second.resourceLoader, first.resourceLoader);
    await second.settingsManager.flush();
    assert.equal(fs.readFileSync(globalSettingsPath, "utf8"), original);
  }));

  test("model selection is exact: missing provider, case and partial IDs never fall back", async () => withFixture({}, async (f) => {
    for (const route of [{ provider: "missing" }, { modelId: "exact" }, { modelId: "EXACT/model" }]) {
      await assert.rejects(f.create({ info: { ...f.info, ...route } }), /Model is not available:/);
    }
    assert.equal(f.sessions.size, 0);
    assert.equal(f.events().filter((event) => event.type === "request").length, 0);
    assert.equal(f.events().filter((event) => event.type === "factory").length, 3);
  }));

  test("filterModels cannot be bypassed by catalog getModel/setModel", async () => withFixture({ filtered: true }, async (f) => {
    await assert.rejects(f.create(), /Model is not available:/);
    assert.equal(f.sessions.size, 0);
    const services = await createAgentSessionServices({
      cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
      resourceLoaderOptions: { noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true,
        systemPrompt: f.systemPromptPath, appendSystemPrompt: [], additionalExtensionPaths: [f.extensionPath] },
    });
    const catalogModel = services.modelRuntime.getModel(f.info.provider, f.info.modelId)!;
    assert.ok(catalogModel);
    assert.deepEqual(await services.modelRuntime.getAvailable(f.info.provider), []);
    // This raw SDK path deliberately bypasses our availability guard to pin the upstream hazard.
    const { session } = await createAgentSessionFromServices({ services, model: catalogModel, sessionManager: SessionManager.inMemory(f.cwd) });
    f.sessions.add(session);
    await session.setModel(catalogModel);
    assert.equal(session.model?.id, f.info.modelId);
    assert.deepEqual(await session.modelRuntime.getAvailable(f.info.provider), []);
  }));

  test("binding must not filter away or replace the exact selected route", async () => {
    for (const config of [{ filterAtStart: true }, { changeModelAtStart: true }]) await withFixture(config, async (f) => {
      let startupError: unknown;
      try { await f.create(); } catch (error) { startupError = error; }
      assert.ok(startupError, JSON.stringify(f.events()));
      assert.match(String(startupError), config.filterAtStart ? /not available after extension binding/ : /changed the selected model/);
      assert.equal(f.sessions.size, 1, "onCreated transfers ownership before binding can fail");
      assert.equal(f.events().filter((event) => event.type === "factory").length, 1);
      assert.equal(f.events().filter((event) => event.type === "request").length, 0);
    });
  });

  test("services report invalid provider registration even if same-name model remains available", async () => withFixture({ badRegistration: true }, async (f) => {
    await assert.rejects(f.create(), /Extension .* error:/);
    assert.equal(f.sessions.size, 0);
    assert.equal(f.events().filter((event) => event.type === "factory").length, 1);
    const services = await createAgentSessionServices({
      cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
      resourceLoaderOptions: { noContextFiles: true, noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true,
        systemPrompt: f.systemPromptPath, appendSystemPrompt: [], additionalExtensionPaths: [f.extensionPath] },
    });
    assert.ok(services.diagnostics.some((diagnostic) => diagnostic.type === "error"));
    assert.ok((await services.modelRuntime.getAvailable(f.info.provider)).some((model) => model.id === f.info.modelId));
  }));

  test("registration errors during session_start cannot silently retain the same-name old model", async () => withFixture({ badRegistrationAtStart: true }, async (f) => {
    await assert.rejects(f.create(), /Extension .* error:/);
    assert.equal(f.sessions.size, 1);
    assert.ok(f.errors.length > 0);
    assert.equal(f.events().filter((event) => event.type === "request").length, 0);
  }));

  test("explicit extension load errors fail before creating a Session", async () => withFixture({}, async (f) => {
    const broken = path.join(f.root, "broken-extension.ts");
    write(broken, 'export default () => { throw new Error("explicit factory failure"); };');
    await assert.rejects(f.create({ info: { ...f.info, extensionPaths: [...f.info.extensionPaths!, broken] } }), /explicit factory failure/);
    assert.equal(f.sessions.size, 0);
    const missing = path.join(f.root, "missing-extension.ts");
    await assert.rejects(f.create({ info: { ...f.info, extensionPaths: [...f.info.extensionPaths!, missing] } }), /missing-extension/);
    assert.equal(f.sessions.size, 0);
  }));

  test("ordinary skill warnings are logged rather than promoted to startup failure", async () => withFixture({}, async (f) => {
    const invalidSkill = path.join(f.root, "warning-skill", "SKILL.md");
    write(invalidSkill, "---\nname: warning-skill\n---\nMissing description");
    await f.create({ info: { ...f.info, skillPaths: [invalidSkill] } });
    assert.equal(f.logs.filter((message) => message.includes("warning") && message.includes("description")).length, 1, JSON.stringify(f.logs));
  }));

  test("resources_discover diagnostics are checked after binding and unchanged warnings are not logged twice", async () => withFixture({}, async (f) => {
    const invalidSkill = path.join(f.root, "hook-warning", "SKILL.md");
    write(invalidSkill, "---\nname: hook-warning\n---\nMissing description");
    f.configure({ resources: { skillPaths: [invalidSkill] } });
    await f.create();
    assert.equal(f.logs.filter((message) => message.includes("description")).length, 1, JSON.stringify(f.logs));
  }));

  test("explicit package and resources_discover may contribute native companion resources", async () => withFixture({}, async (f) => {
    const packageSkill = path.join(f.extensionDir, "package-skill", "SKILL.md");
    const hookSkill = path.join(f.root, "hook-skill", "SKILL.md");
    const hookPrompt = path.join(f.root, "hook-template.md");
    write(packageSkill, "---\nname: package-skill\ndescription: Package companion\n---\nBody");
    write(hookSkill, "---\nname: hook-skill\ndescription: Hook companion\n---\nBody");
    write(path.join(f.extensionDir, "package-template.md"), "PACKAGE_TEMPLATE_BODY");
    write(hookPrompt, "HOOK_TEMPLATE_BODY");
    json(path.join(f.extensionDir, "package.json"), { name: "offline-fixture", pi: { extensions: ["./index.ts"], skills: ["./package-skill"], prompts: ["./package-template.md"] } });
    f.configure({ resources: { skillPaths: [hookSkill], promptPaths: [hookPrompt] } });
    const session = await f.create({ info: { ...f.info, extensionPaths: [f.extensionDir] } });
    assert.deepEqual(session.resourceLoader.getSkills().skills.map((skill) => skill.name).sort(), ["hook-skill", "package-skill"]);
    assert.deepEqual(session.resourceLoader.getPrompts().prompts.map((template) => template.name).sort(), ["hook-template", "package-template"]);
    await prompt(session, "/hook-template");
    assert.deepEqual(f.events().find((event) => event.type === "request")!.userTexts, ["HOOK_TEMPLATE_BODY"]);
    assert.equal(f.events().filter((event) => event.type === "factory").length, 1);
  }));

  test("factory executes once per Session; same-cwd reopen keeps cached module code but fresh instance state", async () => withFixture({}, async (f) => {
    const first = await f.create();
    await prompt(first, "one");
    await f.close(first);
    write(f.extensionPath, fs.readFileSync(f.extensionPath, "utf8").replace('const MODULE_VERSION = "fixture-v1"', 'const MODULE_VERSION = "fixture-v2"'));
    const second = await f.create();
    await prompt(second, "two");
    assert.deepEqual(f.events().filter((event) => event.type === "factory").map((event) => event.moduleVersion), ["fixture-v1", "fixture-v1"]);
    assert.deepEqual(f.events().filter((event) => event.type === "request").map((event) => event.request), [1, 1]);
    assert.equal(f.events().filter((event) => event.type === "session_start").length, 2);
  }));

  test("initialization cancellation checks after services and after binding; ownership precedes cancellation", async () => {
    await withFixture({ factoryGate: true }, async (f) => {
      let canceled = false;
      const creating = f.create({ checkCanceled() { if (canceled) throw new Error("canceled during factory"); } });
      await f.waitFor("factory"); canceled = true; f.release("factory");
      await assert.rejects(creating, /canceled during factory/);
      assert.equal(f.sessions.size, 0);
    });
    await withFixture({ startupGate: true }, async (f) => {
      let canceled = false;
      const creating = f.create({ checkCanceled() { if (canceled) throw new Error("canceled during binding"); } });
      await f.waitFor("session_start");
      assert.equal(f.sessions.size, 1);
      canceled = true; f.release("startup");
      await assert.rejects(creating, /canceled during binding/);
      assert.equal(f.events().filter((event) => event.type === "request").length, 0);
    });
    await withFixture({}, async (f) => {
      let canceled = false;
      await assert.rejects(f.create({ onCreated() { canceled = true; }, checkCanceled() { if (canceled) throw new Error("canceled after creation"); } }), /canceled after creation/);
      assert.equal(f.sessions.size, 1);
      assert.equal(f.events().filter((event) => event.type === "session_start").length, 0);
    });
  });

  test("headless mode has no UI; startup and idle ctx.shutdown synchronously notify only this child", async () => {
    await withFixture({ shutdownAtStart: true }, async (f) => {
      let closing = false;
      await assert.rejects(f.create({ onShutdown() { closing = true; }, checkCanceled() { if (closing) throw new Error("child closing"); } }), /child closing/);
      assert.equal(closing, true);
      const start = f.events().find((event) => event.type === "session_start")!;
      assert.equal(start.mode, "print"); assert.equal(start.hasUI, false);
      assert.equal(f.sessions.size, 1);
    });
    await withFixture({}, async (f) => {
      let shutdowns = 0;
      const session = await f.create({ onShutdown() { shutdowns++; } });
      session.extensionRunner.createContext().shutdown();
      assert.equal(shutdowns, 1);
      assert.deepEqual(await prompt(session, "fixture:shutdown"), ["handled"]);
      assert.equal(shutdowns, 2);
      assert.equal(f.events().filter((event) => event.type === "request").length, 0);
    });
  });

  test("preflight started acknowledges acceptance before completion, preserving source rpc", async () => withFixture({ responseGate: true }, async (f) => {
    const session = await f.create();
    const accepted = deferred<Disposition>();
    let finished = false;
    const raw = promptChildSession(session, "work", accepted.resolve);
    const completion = raw.then(() => session.waitForIdle()).then(() => { finished = true; });
    assert.equal(await accepted.promise, "started");
    await f.waitFor("request");
    assert.equal(finished, false);
    assert.equal(session.isStreaming, true);
    assert.equal(f.events().find((event) => event.type === "input")!.source, "rpc");
    f.release("response");
    await completion;
    assert.equal(session.getLastAssistantText(), "offline: work");
  }));

  test("handled without a run is accepted but creates no assistant and must not reuse the previous answer", async () => withFixture({}, async (f) => {
    const session = await f.create();
    await prompt(session, "old answer");
    const before = assistants(session).length;
    assert.deepEqual(await prompt(session, "fixture:handled"), ["handled"]);
    assert.equal(assistants(session).length, before);
    assert.equal(session.getLastAssistantText(), "offline: old answer", "SDK history lookup is NOT a per-run result");
  }));

  test("rejected preflight never reports acceptance", async () => withFixture({ responseGate: true }, async (f) => {
    const session = await f.create();
    const first = prompt(session, "busy");
    await f.waitFor("request");
    const accepted: Disposition[] = [];
    await assert.rejects(promptChildSession(session, "reject while busy", (d) => { accepted.push(d); }), /already processing/);
    assert.deepEqual(accepted, []);
    await session.abort();
    await first;
  }));

  test("handled may start independent SDK work: prompt resolves, chained waitForIdle still waits", async () => withFixture({ responseGate: true }, async (f) => {
    const session = await f.create();
    const accepted: Disposition[] = [];
    const raw = promptChildSession(session, "fixture:handled-run", (d) => { accepted.push(d); });
    let finished = false;
    const completion = raw.then(() => session.waitForIdle()).then(() => { finished = true; });
    await raw;
    assert.deepEqual(accepted, ["handled"]);
    await f.waitFor("request");
    assert.equal(finished, false);
    assert.equal(session.isStreaming, true);
    f.release("response");
    await completion;
    assert.equal(session.getLastAssistantText(), "offline: work started by handled input");
  }));

  test("abort idle does not cancel blocked input; caller must track raw prompt and abort late preflight", async () => withFixture({ responseGate: true }, async (f) => {
    const session = await f.create();
    let closing = false;
    let lateAbort: Promise<void> | undefined;
    const accepted: Disposition[] = [];
    const raw = promptChildSession(session, "fixture:input-gate", (disposition) => {
      accepted.push(disposition);
      if (closing) { lateAbort = session.abort(); void lateAbort.catch(() => {}); }
    });
    let finished = false;
    const completion = raw.then(() => session.waitForIdle()).then(() => { finished = true; });
    await f.waitFor("input");
    closing = true;
    await session.abort();
    assert.equal(finished, false);
    assert.deepEqual(accepted, []);
    f.release("input");
    await completion;
    await lateAbort;
    assert.deepEqual(accepted, ["started"]);
    assert.equal(session.isStreaming, false);
  }));

  test("two child runtimes, histories and provider instances remain independent; steer settles once", async () => withFixture({ responseGate: true, prefix: "first" }, async (f) => {
    const first = await f.create();
    f.configure({ responseGate: true, prefix: "second" });
    const second = await f.create({ info: { ...f.info, sessionFile: path.join(f.root, "subagents", "second.jsonl") } });
    let settled = 0;
    first.subscribe((event) => { if (event.type === "agent_settled") settled++; });
    assert.notEqual(first.sessionId, second.sessionId);
    assert.notEqual(first.modelRuntime, second.modelRuntime);
    assert.notEqual(first.modelRuntime.getProvider(f.info.provider), second.modelRuntime.getProvider(f.info.provider));
    const firstRun = prompt(first, "initial first");
    const secondRun = prompt(second, "initial second");
    await f.waitFor("request", (event) => event.userTexts.includes("initial second"));
    assert.equal(await first.steer("steered first", undefined, { source: "rpc" }), "queued");
    await second.abort();
    await secondRun;
    assert.equal(first.isStreaming, true);
    f.release("response");
    await firstRun;
    assert.equal(settled, 1);
    assert.equal(first.getLastAssistantText(), "first: steered first");
    assert.ok(!JSON.stringify(first.messages).includes("initial second"));
    assert.ok(!JSON.stringify(second.messages).includes("steered first"));
    assert.equal(f.events().find((event) => event.type === "input" && event.text === "steered first")!.source, "rpc");
  }));

  test("late asynchronous steer may say queued after original run is idle (manager must recheck)", async () => withFixture({ responseGate: true }, async (f) => {
    const session = await f.create();
    const run = prompt(session, "original");
    await f.waitFor("request");
    const steering = session.steer("fixture:steer-gate", undefined, { source: "rpc" });
    await f.waitFor("input", (event) => event.text === "fixture:steer-gate");
    f.release("response");
    await run;
    f.release("input");
    assert.equal(await steering, "queued");
    assert.equal(session.isStreaming, false);
    assert.deepEqual(session.getSteeringMessages(), ["fixture:steer-gate"]);
    session.clearQueue();
  }));

  test("standard JSONL opens/resumes in the same file without entering the default resume list", async () => withFixture({}, async (f) => {
    const old = SessionManager.open(f.info.sessionFile, path.dirname(f.info.sessionFile), "old-cwd");
    old.appendMessage({ role: "user", content: "old RPC-era user history", timestamp: Date.now() });
    const sessionId = old.getSessionId();
    const first = await f.create();
    assert.equal(first.sessionId, sessionId);
    assert.equal(first.sessionManager.getCwd(), f.cwd);
    assert.equal(first.sessionFile, f.info.sessionFile);
    await prompt(first, "continue child");
    await f.close(first);
    const second = await f.create();
    await prompt(second, "continue again");
    assert.equal(second.sessionFile, f.info.sessionFile);
    assert.equal(assistants(second).length, 2);
    assert.deepEqual(f.events().filter((event) => event.type === "request").at(-1)!.userTexts,
      ["old RPC-era user history", "continue child", "continue again"]);
    assert.deepEqual(await SessionManager.list(f.cwd), []);
    assert.deepEqual(await SessionManager.listAll(), []);
    // cwdOverride changes the runtime cwd, not the old header in the original JSONL.
    assert.equal((await SessionManager.list(f.cwd, path.dirname(f.info.sessionFile))).length, 0);
    assert.equal((await SessionManager.list("old-cwd", path.dirname(f.info.sessionFile))).length, 1);
    assert.equal((await SessionManager.listAll(path.dirname(f.info.sessionFile))).length, 1);
  }));

  test("message_end precedes persistence; turn_end and finished chain see authoritative context usage", async () => withFixture({}, async (f) => {
    const session = await f.create();
    const samples: { event: string; persisted: number; tokens: number | null | undefined }[] = [];
    session.subscribe((event) => {
      if (event.type === "turn_end" || (event.type === "message_end" && event.message.role === "assistant")) {
        samples.push({ event: event.type, persisted: assistants(session).length, tokens: session.getContextUsage()?.tokens });
      }
    });
    await prompt(session, "usage");
    assert.equal(samples.find((sample) => sample.event === "message_end")!.persisted, 0);
    assert.notEqual(samples.find((sample) => sample.event === "message_end")!.tokens, 50_000);
    assert.deepEqual(samples.find((sample) => sample.event === "turn_end"), { event: "turn_end", persisted: 1, tokens: 50_000 });
    assert.equal(session.getContextUsage()?.tokens, 50_000);
    assert.equal(SessionManager.open(f.info.sessionFile).getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 1);
  }));

  test("throwing SDK subscribers can interrupt native assistant append: observer errors must not escape", async () => withFixture({}, async (f) => {
    const session = await f.create();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") throw new Error("observer failure");
    });
    await assert.rejects(promptChildSession(session, "observer", () => {}), /observer failure/);
    unsubscribe();
    assert.equal(assistants(session).length, 0);
  }));

  test("normal prompt return is not model success: stopReason error/aborted remain authoritative", async () => {
    for (const stopReason of ["error", "aborted"] as const) await withFixture({ stopReason }, async (f) => {
      const session = await f.create();
      assert.deepEqual(await prompt(session, "fail response"), ["started"]);
      const message = session.messages.filter((message) => message.role === "assistant").at(-1)!;
      assert.equal(message.stopReason, stopReason);
      assert.match(message.errorMessage!, /fixture/);
    });
  });

  test("abort requested during preflight settles as aborted without making a provider request", async () => withFixture({}, async (f) => {
    const session = await f.create();
    const settled: boolean[] = [];
    session.subscribe((event) => { if (event.type === "agent_settled") settled.push(event.aborted); });
    assert.deepEqual(await prompt(session, "fixture:abort-before-run"), ["started"]);
    assert.deepEqual(settled, [true]);
    // SDK 1.4 can synthesize an error assistant on this cancellation path. The
    // manager must honor settled.aborted rather than requiring stopReason=aborted.
    const assistant = session.messages.filter((message) => message.role === "assistant").at(-1)!;
    assert.equal(assistant.stopReason, "error");
    assert.equal(f.events().filter((event) => event.type === "request").length, 0, JSON.stringify(f.events()));
  }));

  test("shutdown emits explicitly once, then disposes; successful paths clear their timeout", async () => withFixture({}, async (f) => {
    const session = await f.create();
    const ctx = session.extensionRunner.createContext();
    await prompt(session, "finish");
    await f.close(session, 60_000);
    assert.equal(f.events().filter((event) => event.type === "session_shutdown").length, 1);
    assert.equal(f.events().filter((event) => event.type === "shutdown_finished").length, 1);
    assert.throws(() => ctx.isProjectTrusted(), /stale/);
  }));

  test("bounded shutdown reports a timeout and still disposes while tracking late hook exit", async () => withFixture({ shutdownGate: true }, async (f) => {
    const session = await f.create();
    const ctx = session.extensionRunner.createContext();
    await assert.rejects(f.close(session, 20), /session_shutdown timed out after 20ms/);
    assert.equal(f.events().filter((event) => event.type === "session_shutdown").length, 1);
    assert.throws(() => ctx.isProjectTrusted(), /stale/);
    f.release("shutdown");
    await f.waitFor("shutdown_finished");
  }));

  test("shutdown hook errors reach native onError and cannot skip disposal", async () => withFixture({ shutdownError: true }, async (f) => {
    const session = await f.create();
    const ctx = session.extensionRunner.createContext();
    await f.close(session);
    assert.ok(f.errors.some((error: any) => error.event === "session_shutdown" && error.error.includes("fixture shutdown failure")));
    assert.throws(() => ctx.isProjectTrusted(), /stale/);
  }));

  test("runtime never changes the host cwd or environment", async () => withFixture({}, async (f) => {
    const cwd = process.cwd();
    const env = { ...process.env };
    const session = await f.create();
    await prompt(session, "environment");
    await f.close(session);
    assert.equal(process.cwd(), cwd);
    assert.deepEqual({ ...process.env }, env);
  }));
}
