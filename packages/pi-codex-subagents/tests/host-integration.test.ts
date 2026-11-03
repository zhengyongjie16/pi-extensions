import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = path.resolve(import.meta.dir, "..");
const entry = path.join(packageDir, "src", "index.ts");
const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const toolNames = ["spawn_agent", "wait_agent", "wait_all_agents", "list_agents", "read_agent_response", "send_message", "interrupt_agent"];

// Separate processes keep module mocks, SDK caches, and agent directories out of sibling suites.
function probe(source: string, executable = process.execPath, extensionEntry = entry): void {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-"));
  try {
    const script = path.join(temporary, "probe.mjs");
    fs.writeFileSync(script, source);
    const result = spawnSync(executable, [script, extensionEntry], {
      cwd: packageDir, encoding: "utf8", timeout: 40_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: temporary, PI_SUBAGENT_TEMP_DIR: temporary },
    });
    if (result.status !== 0) throw new Error(`Host probe failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const hostFixture = `
  import assert from "node:assert/strict";
  import * as fs from "node:fs";
  import * as path from "node:path";
  const { AgentManager } = await import(${JSON.stringify(pathToFileURL(path.join(packageDir, "src", "core.ts")).href)});
  const { default: extension } = await import(${JSON.stringify(pathToFileURL(entry).href)});
  let options;
  let shutdownCalls = 0;
  AgentManager.prototype.ready = async function() { options = this.options; };
  AgentManager.prototype.shutdown = async function() { shutdownCalls++; };
  AgentManager.prototype.listAgents = () => [];
  function host() {
    const tools = new Map(), handlers = new Map(), commands = new Map(), shortcuts = new Map(), renderers = new Map();
    const messages = [], notifications = [], widgets = [];
    const ctx = {
      cwd: process.env.PI_CODING_AGENT_DIR, mode: "tui", hasUI: true,
      isProjectTrusted: () => true,
      model: { provider: "test", id: "fake" },
      modelRegistry: { getAvailable: () => [{ provider: "test", id: "fake" }] },
      sessionManager: { getSessionId: () => "parent", getSessionFile: () => "parent.jsonl" },
      ui: {
        notify: (...args) => notifications.push(args),
        setWidget: (...args) => widgets.push(args),
        custom: async () => undefined,
      },
    };
    const pi = {
      on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
      registerTool(tool) { tools.set(tool.name, tool); },
      registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
      registerCommand(name, command) { commands.set(name, command); },
      registerShortcut(name, shortcut) { shortcuts.set(name, shortcut); },
      getActiveTools: () => ["read"], getThinkingLevel: () => "high", getSettings: () => ({}),
      sendMessage: (message, delivery) => messages.push({ message, delivery }),
    };
    return {
      tools, commands, shortcuts, renderers, messages, notifications, widgets, ctx, pi,
      async emit(name, event = {}, context = ctx) {
        for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, context);
      },
      call(name, params, context = ctx, signal) { return tools.get(name).execute("test-call", params, signal, undefined, context); },
    };
  }
`;

test("preserves the seven schemas, dynamic routing/skills, tool arguments, and return wrappers", () => {
  probe(hostFixture + String.raw`
    const f = host();
    await extension(f.pi);
    assert.deepEqual([...f.tools.keys()], ${JSON.stringify(toolNames)});
    assert.deepEqual([...f.commands.keys()], ["subagents"]);
    assert.deepEqual([...f.renderers.keys()], ["pi-codex-subagent-completion"]);
    assert.equal(options, undefined, "factory must not initialize a session-scoped manager");
    const plain = schema => JSON.parse(JSON.stringify(schema, (key, value) => key === "description" ? undefined : value));
    const object = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
    const string = { type: "string" }, targets = { type: "array", items: string };
    assert.deepEqual(plain(f.tools.get("spawn_agent").parameters), object({
      task_name: string, message: string, agent_type: string, skills: targets,
    }, ["task_name", "message"]));
    for (const name of ["wait_agent", "wait_all_agents"]) assert.deepEqual(plain(f.tools.get(name).parameters), object({ targets }));
    assert.deepEqual(plain(f.tools.get("list_agents").parameters), object({
      path_prefix: string, include_all: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 },
    }));
    for (const name of ["read_agent_response", "interrupt_agent"]) assert.deepEqual(plain(f.tools.get(name).parameters), object({ target: string }, ["target"]));
    assert.deepEqual(plain(f.tools.get("send_message").parameters), object({ target: string, message: string }, ["target", "message"]));
    const config = path.join(f.ctx.cwd, "pi-codex-subagents", "config.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ models: ["test/fake"] }));
    await f.emit("session_start");
    const spawnSchema = plain(f.tools.get("spawn_agent").parameters);
    assert.deepEqual(spawnSchema.properties.model, { type: "string", enum: ["test/fake"] });
    assert.deepEqual(spawnSchema.properties.thinking.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(spawnSchema.required, ["task_name", "message"]);
    await f.emit("before_agent_start", { systemPromptOptions: { skills: [
      { name: "chosen", description: "selected", filePath: "/skill/SKILL.md" },
      { name: "hidden", disableModelInvocation: true, filePath: "/hidden/SKILL.md" },
    ] } });
    assert.ok(f.tools.get("spawn_agent").description.includes("chosen"));
    assert.ok(!f.tools.get("spawn_agent").description.includes("hidden"));
    let spawned;
    AgentManager.prototype.spawnAgent = async params => { spawned = params; return { task_name: "/task", nickname: null }; };
    AgentManager.prototype.getAgentInfo = () => ({ provider: "test", modelId: "fake", thinking: "high" });
    const spawn = await f.call("spawn_agent", { task_name: "task", message: "work", skills: ["chosen"], model: "test/fake", thinking: "high" });
    assert.deepEqual(spawn, { content: [{ type: "text", text: "Spawned /task." }], details: { task_name: "/task", nickname: null, provider: "test", modelId: "fake", thinking: "high" } });
    assert.equal(spawned.parentSessionId, "parent");
    assert.equal(spawned.cwd, f.ctx.cwd);
    assert.equal(spawned.parentSessionFile, "parent.jsonl");
    assert.equal(spawned.inheritedTools, "read");
    assert.deepEqual(spawned.loadedSkillPaths, { chosen: "/skill/SKILL.md" });
    const signal = new AbortController().signal;
    let waited;
    AgentManager.prototype.waitAgent = async (...args) => { waited = args; return { message: "done", event: { status: "completed" } }; };
    const wait = await f.call("wait_agent", { targets: [" /task "] }, f.ctx, signal);
    assert.deepEqual(waited, ["parent", ["task"], signal]);
    assert.deepEqual(JSON.parse(wait.content[0].text), { message: "done", event: { status: "completed" } });
    assert.deepEqual(wait.details, { message: "done" });
    AgentManager.prototype.waitAllAgents = async (...args) => { waited = args; return { message: "all done", responses: [] }; };
    const all = await f.call("wait_all_agents", {}, f.ctx, signal);
    assert.deepEqual(waited, ["parent", undefined, signal]);
    assert.deepEqual(JSON.parse(all.content[0].text), { message: "all done", responses: [] });
    let listed;
    AgentManager.prototype.listAgents = (...args) => { listed = args; return Array.from({ length: 12 }, (_, n) => ({ agent_name: "/" + n, agent_status: "completed", ...(args[2] ? { parent_session_id: "other" } : {}) })); };
    const list = await f.call("list_agents", {});
    assert.deepEqual(listed, [undefined, "parent", false]);
    assert.equal(list.details.returned, 10);
    assert.equal(list.details.next_offset, 10);
    const history = await f.call("list_agents", { include_all: true, offset: 10 });
    assert.deepEqual(listed, [undefined, "parent", true]);
    assert.equal(history.details.returned, 2);
    assert.equal(history.details.agents[0].parent_session_id, "other");
    let scoped;
    AgentManager.prototype.readAgentResponse = (...args) => { scoped = args; return { agent_name: "/task", status: "completed", finalResponse: "answer" }; };
    const read = await f.call("read_agent_response", { target: " /task " });
    assert.deepEqual(scoped, ["task", "parent"]);
    assert.deepEqual(read.details, { agent_name: "/task", status: "completed" });
    assert.equal(JSON.parse(read.content[0].text).finalResponse, "answer");
    for (const delivery of ["steer", "prompt"]) {
      AgentManager.prototype.sendMessage = async (...args) => { scoped = args; return { delivery, status: "running" }; };
      const send = await f.call("send_message", { target: "/task", message: "next" });
      assert.deepEqual(scoped, ["parent", "task", "next"]);
      assert.deepEqual(send.details, { target: "/task", delivery, status: "running" });
    }
    AgentManager.prototype.interruptAgent = async (...args) => { scoped = args; return { previous_status: "running" }; };
    const interrupt = await f.call("interrupt_agent", { target: "/task" });
    assert.deepEqual(scoped, ["parent", "task"]);
    assert.deepEqual(interrupt, { content: [{ type: "text", text: "Interrupt request handled." }], details: { previous_status: "running" } });
    await f.emit("session_shutdown", { reason: "quit" });
  `);
});

test("prefers exact registered model IDs before legacy thinking suffixes without changing the allowlist union", () => {
  probe(hostFixture + String.raw`
    const f = host();
    const available = [
      { provider: "test", id: "fake" }, { provider: "test", id: "fake:high" },
      { provider: "test", id: "only:low" }, { provider: "test", id: "accounts/team/model:high" },
      { provider: "other", id: "scoped:max" },
    ];
    f.ctx.modelRegistry.getAvailable = () => available;
    f.ctx.scopedModels = [{ model: available[1] }, { model: available[4] }];
    const config = path.join(f.ctx.cwd, "pi-codex-subagents", "config.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({
      models: ["test/fake:high", "test/only:low", "test/fake:medium", "test/accounts/team/model:high", "test/fake:unknown", "fake", "test/*:high"],
      modelsFromEnabledModels: true,
    }));
    await extension(f.pi);
    await f.emit("session_start");
    try {
      const models = ["test/fake:high", "test/only:low", "test/fake", "test/accounts/team/model:high", "other/scoped:max"];
      assert.deepEqual(f.tools.get("spawn_agent").parameters.properties.model.enum, models);
      assert.deepEqual(f.notifications, [["spawn_agent models not available: test/fake:unknown, fake, test/*:high", "warning"]]);
      let spawned;
      AgentManager.prototype.spawnAgent = async params => { spawned = params; return { task_name: "/task" }; };
      AgentManager.prototype.getAgentInfo = () => ({ ...spawned.model, thinking: spawned.inheritedThinking });
      for (const model of models) {
        await f.call("spawn_agent", { task_name: "task", message: "work", model });
        assert.equal(spawned.model.provider + "/" + spawned.model.modelId, model);
        assert.equal(spawned.thinking, undefined, "a model suffix must not override inherited thinking");
      }
      // Even when there is no unsuffixed model, the full registered ID is usable.
      available.splice(0, 1);
      fs.writeFileSync(config, JSON.stringify({ models: ["test/fake:high"] }));
      await f.emit("session_start");
      assert.deepEqual(f.tools.get("spawn_agent").parameters.properties.model.enum, ["test/fake:high"]);
    } finally { await f.emit("session_shutdown", { reason: "quit" }); }
  `);
});

test("forwards only current same-cwd effective trust and reports errors without changing control flow", () => {
  probe(hostFixture + String.raw`
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    let trusted = true, trustReads = 0;
    f.ctx.isProjectTrusted = () => { trustReads++; return trusted; };
    assert.equal(options.projectTrusted(f.ctx.cwd), true);
    trusted = false;
    assert.equal(options.projectTrusted(path.join(f.ctx.cwd, ".")), false);
    assert.equal(options.projectTrusted(path.join(f.ctx.cwd, "other")), undefined);
    assert.equal(trustReads, 2, "a different cwd must never borrow parent trust");
    trusted = "invalid";
    assert.equal(options.projectTrusted(f.ctx.cwd), undefined);
    const next = { ...f.ctx, isProjectTrusted: () => false };
    AgentManager.prototype.sendMessage = async () => ({ delivery: "prompt" });
    await f.call("send_message", { target: "task", message: "resume" }, next);
    assert.equal(options.projectTrusted(next.cwd), false, "resumption must use its current context, not the startup snapshot");
    options.onError(new Error("subscription/save failed"));
    assert.deepEqual(f.notifications.pop(), ["[subagents] subscription/save failed", "error"]);
    const logged = [], previous = console.error;
    console.error = (...args) => logged.push(args.join(" "));
    try {
      next.ui.notify = () => { throw new Error("UI unavailable"); };
      assert.doesNotThrow(() => options.onError(new Error("cleanup failed")));
      next.hasUI = false;
      assert.doesNotThrow(() => options.onError(new Error("headless failure")));
      assert.ok(logged.some(line => line.includes("cleanup failed")));
      assert.ok(logged.some(line => line.includes("headless failure")));
      await f.emit("session_shutdown", { reason: "quit" }, next);
      assert.equal(options.projectTrusted(next.cwd), undefined);
    } finally { console.error = previous; }
  `);
});

test("warns when storage overlaps the current parent's custom native session directory", () => {
  probe(hostFixture + String.raw`
    const f = host();
    const config = path.join(f.ctx.cwd, "pi-codex-subagents", "config.json");
    const sessionDir = path.join(f.ctx.cwd, "custom-sessions");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ storageDir: path.join(sessionDir, "runs") }));
    f.ctx.sessionManager.getSessionDir = () => sessionDir;
    await extension(f.pi);
    await f.emit("session_start");
    assert.ok(f.notifications.some(([message, level]) => level === "error" && message.includes("overlaps the parent session directory") && message.includes("/resume")));
    await f.emit("session_shutdown", { reason: "quit" });
  `);
});

test("keeps scoped notifications, bounded full output, and widget/shortcut integration", () => {
  probe(hostFixture + String.raw`
    const config = path.join(process.env.PI_CODING_AGENT_DIR, "pi-codex-subagents", "config.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ shortcut: "ctrl+shift+a" }));
    const f = host();
    await extension(f.pi);
    await f.emit("session_start");
    assert.deepEqual([...f.shortcuts.keys()], ["ctrl+shift+a"]);
    options.onActivityChange({ parentSessionId: "other", agentName: "/ignored", active: true });
    options.onActivityChange({ parentSessionId: "parent", agentName: "/task", active: true });
    const [key, widget] = f.widgets.at(-1);
    assert.equal(key, "pi-codex-subagents");
    const theme = { fg: (_color, text) => text };
    assert.ok(widget({}, theme).render(80).join("\n").includes("/task running"));
    assert.ok(widget({}, theme).render(30).join("\n").includes("/subagents"));
    options.onUnclaimedCompletion({ parentSessionId: "other", agentName: "/ignored", status: "completed" });
    assert.equal(f.messages.length, 0);
    const event = { parentSessionId: "parent", agentName: "/task", status: "completed", finalResponse: "answer" };
    options.onUnclaimedCompletion(event);
    assert.deepEqual(f.messages[0], { message: {
      customType: "pi-codex-subagent-completion",
      content: "<subagent_notification>\n" + JSON.stringify({ agent_name: "/task", status: "completed", final_response: "answer" }, null, 2) + "\n</subagent_notification>",
      display: true, details: { agent_name: "/task", status: "completed" },
    }, delivery: { deliverAs: "steer", triggerTurn: true } });
    options.onUnclaimedCompletion({ ...event, finalResponse: "x".repeat(100_000) });
    const large = f.messages.at(-1).message;
    assert.ok(Buffer.byteLength(large.content) <= 50 * 1024);
    assert.ok(large.content.includes("Output truncated"));
    assert.ok(fs.readFileSync(large.details.fullOutputPath, "utf8").includes("x".repeat(100_000)));
    options.onActivityChange({ parentSessionId: "parent", agentName: "/task", active: false });
    assert.equal(f.widgets.at(-1)[1], undefined);
    await f.emit("session_shutdown", { reason: "quit" });
    options.onUnclaimedCompletion(event);
    assert.equal(f.messages.length, 2, "no stale delivery after shutdown");
  `);
});

test("reports persistence/cleanup errors on every shutdown reason even if widget cleanup fails", () => {
  probe(hostFixture + String.raw`
    for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
      const f = host();
      await extension(f.pi);
      await f.emit("session_start");
      const count = shutdownCalls;
      AgentManager.prototype.shutdown = async function() {
        shutdownCalls++;
        throw new AggregateError([new Error("save failed"), new Error("dispose failed")], "shutdown failed");
      };
      f.ctx.ui.setWidget = () => { throw new Error("widget cleanup failed"); };
      await f.emit("session_shutdown", { reason });
      assert.equal(shutdownCalls, count + 1);
      const errors = f.notifications.map(([message]) => message).join("\n");
      for (const text of ["widget cleanup failed", "save failed", "dispose failed"]) assert.ok(errors.includes(text), errors);
    }
  `);
});

const runtimes: Array<[string, string]> = [["Bun", process.execPath]];
if (Bun.which("node")) runtimes.push(["Node", Bun.which("node")!]);


const crossHostObserver = String.raw`
  import assert from "node:assert/strict";
  import net from "node:net";
  const socket = net.connect(process.argv[1]);
  socket.setEncoding("utf8");
  const timer = setTimeout(() => { console.error("observer timed out"); process.exit(2); }, 5000);
  let buffer = "", synchronized = false;
  socket.on("error", error => { console.error(error); process.exit(2); });
  socket.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n"), event = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (event.type === "sync") {
        assert.equal(event.status, "calling");
        assert.deepEqual(event.partialMessage.content[0], { type: "toolCall", id: "remote-call", name: "read", arguments: { path: "中文" } });
        assert.deepEqual(event.toolArguments, [[0, '{"path":"中文']]);
        synchronized = true;
        process.stdout.write("ready\n");
      } else if (event.type === "message_update") {
        assert.ok(synchronized);
        assert.equal(event.message, undefined);
        assert.equal(event.assistantMessageEvent.partial, undefined);
        assert.equal(event.assistantMessageEvent.delta, '😀\u2028末尾"}');
        clearTimeout(timer);
        socket.end();
        process.stdout.write("verified\n");
      }
    }
  });
`;

test.each(runtimes)("validates dynamic spawn schemas and enforces thinking overrides with real SDK children (%s)", (_name, executable) => {
  probe(String.raw`
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as path from "node:path";
    process.env.PI_OFFLINE = "1";
    const { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
    const { validateToolArguments } = await import(${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))});
    const fixturePath = ${JSON.stringify(path.join(packageDir, "tests", "fixtures", "core-sdk-fixture.ts"))};
    const { configureCoreFixture } = await import(${JSON.stringify(pathToFileURL(path.join(packageDir, "tests", "fixtures", "core-sdk-fixture.ts")).href)});
    const nativeThinking = [];
    const fixture = configureCoreFixture({
      routes: [["test", "fake"], ["test", "fake:high"], ["template-provider", "template-model"]],
      onStart: pi => { nativeThinking.push(pi.getThinkingLevel()); },
    });
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const settings = { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
    const config = path.join(agentDir, "pi-codex-subagents", "config.json");
    const templates = path.join(path.dirname(config), "agents");
    fs.mkdirSync(templates, { recursive: true });
    fs.writeFileSync(path.join(templates, "routed.md"), "---\nname: routed\nprovider: template-provider\nmodel: template-model\nthinking: medium\n---\n");
    const writeConfig = models => fs.writeFileSync(config, JSON.stringify({ defaults: { extensions: [fixturePath] }, ...(models ? { models } : {}) }));
    writeConfig();
    const settingsManager = SettingsManager.inMemory(settings);
    settingsManager.setProjectTrusted(true);
    const services = await createAgentSessionServices({
      cwd: agentDir, agentDir, settingsManager, resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [process.argv[2], fixturePath],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const model = (await services.modelRuntime.getAvailable("test")).find(model => model.id === "fake");
    assert.ok(model);
    const { session } = await createAgentSessionFromServices({ services, model, thinkingLevel: "off", sessionManager: SessionManager.inMemory(agentDir) });
    const errors = [];
    try {
      await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
      const ctx = session.extensionRunner.createContext();
      const spawnTool = () => session.getToolDefinition("spawn_agent");
      const validate = args => validateToolArguments(spawnTool(), { type: "toolCall", id: "routing", name: "spawn_agent", arguments: args });
      const execute = args => spawnTool().execute("routing", args, undefined, undefined, ctx);
      const spawn = async (task_name, extra = {}) => {
        const result = await execute(validate({ task_name, message: "work", ...extra }));
        const child = fixture.instances.at(-1);
        assert.equal(child.ctx.model.provider, result.details.provider);
        assert.equal(child.ctx.model.id, result.details.modelId);
        assert.equal(nativeThinking.at(-1), result.details.thinking);
        const waited = await session.getToolDefinition("wait_agent").execute("wait", { targets: [task_name] }, undefined, undefined, ctx);
        assert.equal(JSON.parse(waited.content[0].text).event.status, "completed");
        return result.details;
      };
      assert.equal(spawnTool().parameters.properties.thinking, undefined);
      const hidden = validate({ task_name: "hidden", message: "work", thinking: "high" });
      assert.equal(hidden.thinking, "high", "native validation permits this undeclared extra property");
      const initialChildren = fixture.instances.length;
      await assert.rejects(execute(hidden), /thinking.*configured spawn models/);
      assert.equal(fixture.instances.length, initialChildren, "rejection must precede child creation");
      assert.equal((await spawn("inherited")).thinking, "off");
      assert.equal((await spawn("template-inherited", { agent_type: "routed" })).thinking, "medium");

      writeConfig(["test/fake", "test/fake:high"]);
      await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      const schema = JSON.parse(JSON.stringify(spawnTool().parameters));
      assert.deepEqual(schema.required, ["task_name", "message"]);
      assert.deepEqual(schema.properties.model, { type: "string", enum: ["test/fake", "test/fake:high"], description: schema.properties.model.description });
      assert.deepEqual(schema.properties.thinking, { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: schema.properties.thinking.description });
      assert.ok(!JSON.stringify(schema).includes("\"~"), "TypeBox internals must not leak into the provider-facing schema");
      assert.equal(validate({ task_name: "optional", message: "work" }).thinking, undefined);
      for (const thinking of schema.properties.thinking.enum) assert.equal(validate({ task_name: "valid", message: "work", thinking }).thinking, thinking);
      const beforeInvalid = fixture.instances.length;
      for (const thinking of ["invalid", "HIGH", "", null, false, 1, [], {}]) {
        await assert.rejects(execute({ task_name: "invalid", message: "work", thinking }), /thinking.*(one of|level)/);
      }
      for (const thinking of ["invalid", "HIGH", "", false, 1, [], {}]) {
        assert.throws(() => validate({ task_name: "invalid", message: "work", thinking }), /thinking/);
      }
      assert.throws(() => validate({ task_name: "invalid-model", message: "work", model: "test/not-allowed" }), /model/);
      assert.equal(fixture.instances.length, beforeInvalid);
      assert.equal((await spawn("ordinary", { model: "test/fake" })).modelId, "fake");
      const colon = await spawn("colon", { model: "test/fake:high" });
      assert.equal(colon.modelId, "fake:high");
      assert.equal(colon.thinking, "off", "the exact ID suffix is not a thinking override");
      const overridden = await spawn("caller-priority", { agent_type: "routed", model: "test/fake:high", thinking: "high" });
      assert.equal(overridden.provider, "test");
      assert.equal(overridden.modelId, "fake:high");
      assert.equal(overridden.thinking, "high");
      assert.equal((await spawn("thinking-only", { thinking: "low" })).thinking, "low");
      assert.equal((await spawn("template-priority", { model: "test/fake", agent_type: "routed" })).thinking, "medium");

      const stale = validate({ task_name: "stale", message: "work", thinking: "high" });
      writeConfig(["missing/model"]);
      await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      assert.equal(spawnTool().parameters.properties.model, undefined);
      assert.equal(spawnTool().parameters.properties.thinking, undefined);
      await assert.rejects(execute(stale), /thinking.*configured spawn models/);
      assert.equal((await spawn("inherited-again")).thinking, "off");
      assert.deepEqual(errors, []);
    } finally {
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.dispose(); }
    }
  `, executable);
});

test.each(runtimes)("keeps mid-run sync and Unicode deltas readable from a separate %s process", (_name, executable) => {
  probe(String.raw`
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import { randomUUID } from "node:crypto";
    const { EventBroadcaster, getSocketPath, toObserverEvent } = await import(${JSON.stringify(pathToFileURL(path.join(packageDir, "src", "core.ts")).href)});
    const id = randomUUID(), broadcaster = new EventBroadcaster(id);
    const message = { role: "assistant", content: [], usage: {}, api: "test", provider: "test", model: "test", timestamp: Date.now(), stopReason: "pending" };
    broadcaster.start();
    broadcaster.broadcast(toObserverEvent({ type: "message_start", message }));
    message.content.push({ type: "toolCall", id: "remote-call", name: "read", arguments: {} });
    broadcaster.broadcast(toObserverEvent({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message } }));
    broadcaster.broadcast(toObserverEvent({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"中文', partial: message } }));
    const observer = spawn(${JSON.stringify(executable)}, ["--input-type=module", "-e", ${JSON.stringify(crossHostObserver)}, getSocketPath(id)], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "", sent = false;
    observer.stdout.setEncoding("utf8");
    observer.stdout.on("data", chunk => {
      output += chunk;
      if (!sent && output.includes("ready")) {
        sent = true;
        broadcaster.broadcast(toObserverEvent({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '😀\u2028末尾"}', partial: message } }));
      }
    });
    observer.stderr.on("data", chunk => { error += chunk; });
    try {
      const code = await new Promise((resolve, reject) => { observer.on("error", reject); observer.on("exit", resolve); });
      assert.equal(code, 0, error);
      assert.ok(output.includes("verified"), output);
      assert.deepEqual(message.content[0].arguments, {}, "observer must never mutate the SDK message");
    } finally { observer.kill(); broadcaster.stop(); }
  `);
});

test.each(runtimes)("runs seven registered tools and repeated child cleanup alongside an active SDK parent (%s)", (_name, executable) => {
  probe(String.raw`
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as path from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    import * as net from "node:net";
    const { AgentSession, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
    const { createAssistantMessageEventStream } = await import(${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))});
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const fixtureSource = ${JSON.stringify(path.join(packageDir, "tests", "fixtures", "sdk-offline-extension.ts"))};
    const fixture = (name, prefix) => {
      const directory = path.join(agentDir, name);
      fs.mkdirSync(directory);
      const extension = path.join(directory, "extension.ts");
      fs.copyFileSync(fixtureSource, extension);
      fs.writeFileSync(path.join(directory, "sdk-fixture.json"), JSON.stringify({ prefix, responseGate: true }));
      return { directory, extension };
    };
    const childFixture = fixture("child-provider", "child");
    const config = path.join(agentDir, "pi-codex-subagents", "config.json");
    fs.mkdirSync(path.dirname(config));
    fs.writeFileSync(config, JSON.stringify({ retentionDays: 0, defaults: { extensions: [childFixture.extension] } }));
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    settingsManager.setProjectTrusted(false);
    let drive, driverError, finishDriver, releaseParent;
    const driverFinished = new Promise(resolve => { finishDriver = resolve; });
    const parentHold = new Promise(resolve => { releaseParent = resolve; });
    const services = await createAgentSessionServices({
      cwd: agentDir, agentDir, settingsManager,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [process.argv[2]],
        extensionFactories: [pi => {
          let request = 0;
          pi.registerProvider("sdk-offline", {
            api: "host-offline", apiKey: "offline-only", baseUrl: "http://offline.invalid",
            models: [{ id: "exact/model", name: "Offline host", reasoning: false, input: ["text"],
              contextWindow: 500_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
            streamSimple(model) {
              const stream = createAssistantMessageEventStream();
              const first = request++ === 0;
              const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
                content: first ? [
                  { type: "toolCall", id: "host-driver-call", name: "host_driver", arguments: {} },
                  { type: "toolCall", id: "parent-hold-call", name: "parent_hold", arguments: {} },
                ] : [{ type: "text", text: "parent: complete" }],
                stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              };
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: message.stopReason, message });
              stream.end();
              return stream;
            },
          });
          pi.registerTool({ name: "host_driver", label: "Host test", description: "Offline seven-tool driver",
            parameters: { type: "object", properties: {} },
            async execute(_id, _args, _signal, _update, ctx) {
              try {
                await drive(ctx);
                return { content: [{ type: "text", text: "seven tools verified" }], details: {} };
              } catch (error) { driverError = error; throw error; }
              finally { finishDriver(); }
            },
          });
          pi.registerTool({ name: "parent_hold", label: "Hold parent", description: "Keep parent work active independently",
            parameters: { type: "object", properties: {} },
            async execute() { await parentHold; return { content: [{ type: "text", text: "parent released" }], details: {} }; },
          });
        }],
      },
    });
    assert.ok(!services.diagnostics.some(diagnostic => diagnostic.type === "error"));
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const model = (await services.modelRuntime.getAvailable("sdk-offline")).find(model => model.id === "exact/model");
    assert.ok(model);
    const { session } = await createAgentSessionFromServices({ services, model, sessionManager: SessionManager.inMemory(agentDir) });
    const errors = [], called = new Set();
    let parentRun, restoreCounters = () => {};
    try {
      await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
      // Count actual child lifecycle calls and observer resources, not RSS heuristics.
      const childSessions = new Set(), subscriptions = new Set(), timeouts = new Set(), intervals = new Set(), servers = new Set();
      let created = 0, disposed = 0;
      const subscribe = AgentSession.prototype.subscribe, dispose = AgentSession.prototype.dispose;
      AgentSession.prototype.subscribe = function(listener) {
        const unsubscribe = subscribe.call(this, listener);
        if (this === session) return unsubscribe;
        if (!childSessions.has(this)) { childSessions.add(this); created++; }
        const token = {};
        subscriptions.add(token);
        return () => { subscriptions.delete(token); unsubscribe(); };
      };
      AgentSession.prototype.dispose = function(...args) {
        try { return dispose.apply(this, args); }
        finally { if (childSessions.delete(this)) disposed++; }
      };
      const originalTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
      globalThis.setTimeout = (callback, ms, ...args) => {
        const timer = originalTimers.setTimeout(() => { timeouts.delete(timer); callback(...args); }, ms);
        timeouts.add(timer);
        return timer;
      };
      globalThis.clearTimeout = timer => { timeouts.delete(timer); return originalTimers.clearTimeout(timer); };
      globalThis.setInterval = (...args) => { const timer = originalTimers.setInterval(...args); intervals.add(timer); return timer; };
      globalThis.clearInterval = timer => { intervals.delete(timer); return originalTimers.clearInterval(timer); };
      const listen = net.Server.prototype.listen;
      net.Server.prototype.listen = function(...args) {
        servers.add(this);
        this.once("close", () => servers.delete(this));
        try { return listen.apply(this, args); } catch (error) { servers.delete(this); throw error; }
      };
      restoreCounters = () => {
        AgentSession.prototype.subscribe = subscribe; AgentSession.prototype.dispose = dispose;
        Object.assign(globalThis, originalTimers); net.Server.prototype.listen = listen;
      };
      const counts = () => ({ sessions: childSessions.size, subscriptions: subscriptions.size, timeouts: timeouts.size, intervals: intervals.size, servers: servers.size });
      const empty = { sessions: 0, subscriptions: 0, timeouts: 0, intervals: 0, servers: 0 };
      const reclaimed = async label => {
        const deadline = Date.now() + 2_000;
        while (Object.values(counts()).some(Boolean) && Date.now() < deadline) await delay(5);
        assert.deepEqual(counts(), empty, label);
        assert.equal(created, disposed, label);
        const files = fs.readdirSync(agentDir, { recursive: true });
        assert.ok(!files.some(file => /\.(active\.json|sock)$/.test(String(file))), label + ": observer files remain");
      };
      // This ctx belongs to host_driver, a REAL assistant-issued call. Nested calls
      // therefore traverse native schema validation, tool hooks, and result recording.
      drive = async ctx => {
        const call = async (name, args, options) => {
          called.add(name);
          const result = await ctx.executeTool(name, args, options);
          assert.ok(!result.isError, JSON.stringify(result));
          return result.result;
        };
        assert.equal(session.isStreaming, true);
        const spawned = await call("spawn_agent", { task_name: "worker", message: "child work" });
        assert.equal(spawned.details.task_name, "/worker");
        assert.equal((await call("list_agents", {})).details.agents[0].agent_status, "running");
        assert.equal((await call("send_message", { target: "/worker", message: "steered work" })).details.delivery, "steer");
        const controller = new AbortController();
        const canceledWait = ctx.executeTool("wait_agent", { targets: ["worker"] }, { signal: controller.signal });
        await delay(5);
        controller.abort(new Error("cancel only the wait"));
        assert.equal((await canceledWait).isError, true);
        assert.equal((await call("list_agents", {})).details.agents[0].agent_status, "running");
        const waiting = call("wait_agent", { targets: ["worker"] });
        await delay(5);
        fs.writeFileSync(path.join(childFixture.directory, "release-response"), "");
        const completion = JSON.parse((await waiting).content[0].text).event;
        assert.equal(completion.status, "completed");
        assert.equal(completion.finalResponse, "child: steered work");
        await reclaimed("initial completion");
        const read = JSON.parse((await call("read_agent_response", { target: "worker" })).content[0].text);
        assert.equal(read.finalResponse, "child: steered work");
        settingsManager.setProjectTrusted(true);
        assert.equal((await call("send_message", { target: "worker", message: "resumed work" })).details.delivery, "prompt");
        const all = JSON.parse((await call("wait_all_agents", { targets: ["worker"] })).content[0].text);
        assert.equal(all.responses[0].finalResponse, "child: resumed work");
        const events = fs.readFileSync(path.join(childFixture.directory, "sdk-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.deepEqual(events.filter(event => event.type === "session_start").map(event => event.trusted), [false, true]);
        await reclaimed("first resumption");
        for (let turn = 0; turn < 8; turn++) {
          await call("send_message", { target: "worker", message: "repeat " + turn });
          const result = JSON.parse((await call("wait_agent", { targets: ["worker"] })).content[0].text);
          assert.equal(result.event.finalResponse, "child: repeat " + turn);
          await reclaimed("repeated resumption " + turn);
          assert.equal(session.isStreaming, true);
        }
        fs.rmSync(path.join(childFixture.directory, "release-response"));
        await call("spawn_agent", { task_name: "canceled", message: "cancel child work" });
        assert.equal((await call("interrupt_agent", { target: "canceled" })).details.previous_status, "running");
        assert.equal((await call("list_agents", {})).details.agents.find(agent => agent.agent_name === "/canceled").agent_status, "interrupted");
        await reclaimed("interruption");
        assert.equal(created, 11);
        assert.equal(disposed, 11);
        assert.equal(session.isStreaming, true, "child work/cancellation must not stop the active parent turn");
        assert.deepEqual([...called].sort(), ${JSON.stringify([...toolNames].sort())});
      };
      parentRun = session.prompt("run the offline host driver").then(() => session.waitForIdle());
      void parentRun.catch(() => {});
      await driverFinished;
      if (driverError) throw driverError;
      releaseParent();
      await parentRun;
      assert.ok(session.getLastAssistantText().startsWith("parent:"));
      const driverResult = session.messages.find(message => message.role === "toolResult" && message.toolName === "host_driver");
      assert.ok(driverResult && !driverResult.isError);
      assert.deepEqual([...new Set(driverResult.nestedCalls.calls.map(call => call.name))].sort(), ${JSON.stringify([...toolNames].sort())});
      assert.deepEqual(errors, []);
    } finally {
      releaseParent();
      fs.writeFileSync(path.join(childFixture.directory, "release-response"), "");
      await session.abort();
      await parentRun?.catch(() => {});
      try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.dispose(); restoreCounters(); }
    }
  `, executable);
});

test.each(runtimes)("uses native parent new/resume/fork/reload/quit lifecycles to clean up children (%s)", (_name, executable) => {
  probe(String.raw`
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as path from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const fixtureSource = ${JSON.stringify(path.join(packageDir, "tests", "fixtures", "sdk-offline-extension.ts"))};
    const provider = name => {
      const directory = path.join(agentDir, name);
      fs.mkdirSync(directory);
      const extension = path.join(directory, "extension.ts");
      fs.copyFileSync(fixtureSource, extension);
      fs.writeFileSync(path.join(directory, "sdk-fixture.json"), JSON.stringify({ responseGate: true }));
      return { directory, extension };
    };
    const parent = provider("parent"), child = provider("child");
    fs.writeFileSync(path.join(parent.directory, "release-response"), "");
    const config = path.join(agentDir, "pi-codex-subagents", "config.json");
    fs.mkdirSync(path.dirname(config));
    fs.writeFileSync(config, JSON.stringify({ retentionDays: 0, defaults: { extensions: [child.extension] } }));
    const started = [], stopped = [], errors = [];
    const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      settingsManager.setProjectTrusted(false);
      const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [process.argv[2], parent.extension],
        extensionFactories: [pi => {
          pi.on("session_start", event => { started.push(event.reason); });
          pi.on("session_shutdown", event => { stopped.push(event.reason); });
        }],
      } });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const model = (await services.modelRuntime.getAvailable("sdk-offline")).find(model => model.id === "exact/model");
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, {
      cwd: agentDir, agentDir, sessionManager: SessionManager.create(agentDir, path.join(agentDir, "native-sessions")),
    });
    const bind = session => session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    let disposed = false, closed = 0;
    const startChild = async task => {
      const session = runtime.session, ctx = session.extensionRunner.createContext();
      const result = await session.getToolDefinition("spawn_agent").execute("lifecycle-probe", { task_name: task, message: "pending child " + task }, undefined, undefined, ctx);
      assert.equal(result.details.task_name, "/" + task);
      return ctx.sessionManager.getSessionId();
    };
    const checkClosed = async (task, parentId) => {
      const deadline = Date.now() + 2_000;
      let files;
      do { files = fs.readdirSync(agentDir, { recursive: true }).map(String);
        if (!files.some(file => /\.(active\.json|sock)$/.test(file))) break;
        await delay(5);
      } while (Date.now() < deadline);
      assert.ok(!files.some(file => /\.(active\.json|sock)$/.test(file)));
      const info = files.filter(file => file.endsWith(".info.json")).map(file => JSON.parse(fs.readFileSync(path.join(agentDir, file), "utf8")))
        .find(info => info.taskName === task && info.parentSessionId === parentId);
      assert.equal(info?.status, "interrupted");
      const events = fs.readFileSync(path.join(child.directory, "sdk-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.type === "shutdown_finished").length, ++closed);
    };
    try {
      await runtime.session.prompt("seed a persistent parent session");
      const originalFile = runtime.session.sessionFile;
      const entryId = runtime.session.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user").id;
      let owner = await startChild("on-new");
      assert.deepEqual(await runtime.newSession(), { cancelled: false });
      await checkClosed("on-new", owner);
      owner = await startChild("on-resume");
      assert.deepEqual(await runtime.switchSession(originalFile), { cancelled: false });
      await checkClosed("on-resume", owner);
      owner = await startChild("on-fork");
      assert.equal((await runtime.fork(entryId, { position: "at" })).cancelled, false);
      await checkClosed("on-fork", owner);
      owner = await startChild("on-reload");
      await runtime.session.reload();
      await checkClosed("on-reload", owner);
      owner = await startChild("on-quit");
      await runtime.dispose();
      disposed = true;
      await checkClosed("on-quit", owner);
      assert.deepEqual(started, ["startup", "new", "resume", "fork", "reload"]);
      assert.deepEqual(stopped, ["new", "resume", "fork", "reload", "quit"]);
      assert.deepEqual(errors, []);
    } finally {
      fs.writeFileSync(path.join(child.directory, "release-response"), "");
      if (!disposed) await runtime.dispose();
    }
  `, executable);
});

const loaderSmoke = `
  import assert from "node:assert/strict";
  import * as fs from "node:fs";
  import * as path from "node:path";
  const { DefaultResourceLoader, SettingsManager } = await import(${JSON.stringify(sdkUrl)});
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const loader = new DefaultResourceLoader({
    cwd: agentDir, agentDir, settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [process.argv[2]],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()], ${JSON.stringify(toolNames)});
  assert.ok(extension.commands.has("subagents"));
  for (const { definition } of extension.tools.values()) {
    const schema = JSON.parse(JSON.stringify(definition.parameters));
    assert.equal(schema.type, "object");
    assert.ok(typeof definition.execute === "function");
  }
  assert.equal(fs.existsSync(path.join(agentDir, "pi-codex-subagents", "runs")), false, "file loading alone must not initialize manager resources");
  for (const shutdown of extension.handlers.get("session_shutdown") ?? []) await shutdown({ type: "session_shutdown", reason: "quit" }, {});
`;

test("loads the source through Pi's real TypeScript extension loader on Bun", () => probe(loaderSmoke));
test.skipIf(!Bun.which("node"))("loads the source through Pi's real TypeScript extension loader on Node", () => probe(loaderSmoke, Bun.which("node")!));

test("packs runtime.ts without an SDK copy and loads the extracted package through Pi", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pack-"));
  try {
    const packed = Bun.spawnSync(["npm", "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: packageDir, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    if (packed.exitCode !== 0) throw new Error(new TextDecoder().decode(packed.stderr));
    const [metadata] = JSON.parse(new TextDecoder().decode(packed.stdout));
    expect(metadata.files.map((file: { path: string }) => file.path).sort()).toEqual(["LICENSE", "README.md", "src/core.ts", "src/index.ts", "package.json", "src/peek.ts", "src/runtime.ts"].sort());
    const unpacked = Bun.spawnSync(["tar", "-xzf", path.join(temporary, metadata.filename), "-C", temporary], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    if (unpacked.exitCode !== 0) throw new Error(new TextDecoder().decode(unpacked.stderr));
    const manifest = JSON.parse(fs.readFileSync(path.join(temporary, "package", "package.json"), "utf8"));
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.bundledDependencies).toBeUndefined();
    for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) expect(manifest.peerDependencies["@earendil-works/" + name]).toBe("1.5.0");
    expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
    const packedEntry = path.join(temporary, "package", "src", "index.ts");
    probe(loaderSmoke, process.execPath, packedEntry);
    if (Bun.which("node")) probe(loaderSmoke, Bun.which("node")!, packedEntry);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
