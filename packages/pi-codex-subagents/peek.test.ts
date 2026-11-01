import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  createBashToolDefinition,
  createCodemodeExtension,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  initTheme,
  SessionManager,
  ToolExecutionComponent,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
  type ToolExecutionOptions,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, setCapabilities, setCellDimensions, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SubagentPeekOverlay } from "./peek.js";

const widths = [38, 80, 100];
const cwd = process.cwd();
const nativeFactories = new Map<string, (cwd: string) => ToolDefinition<any, any, any>>([
  ["bash", (cwd) => defineTool(createBashToolDefinition(cwd))],
  ["edit", (cwd) => defineTool(createEditToolDefinition(cwd))],
  ["find", (cwd) => defineTool(createFindToolDefinition(cwd))],
  ["grep", (cwd) => defineTool(createGrepToolDefinition(cwd))],
  ["ls", (cwd) => defineTool(createLsToolDefinition(cwd))],
  ["powershell", (cwd) => defineTool(createPowerShellToolDefinition(cwd))],
  ["read", (cwd) => defineTool(createReadToolDefinition(cwd))],
  ["write", (cwd) => defineTool(createWriteToolDefinition(cwd))],
]);
const renderUi = { requestRender() {} } as TUI;
const components = new Set<ToolExecutionComponent>();
const overlays: SubagentPeekOverlay[] = [];
const temporaryDirectories: string[] = [];
let nativeCodemodeRenderers: ToolRenderers;
let codemodeDefinition: ToolDefinition<any, any, any>;
const initializationAccesses: PropertyKey[] = [];
let registrationCount = 0;
let clock: ReturnType<typeof controlledClock> | undefined;

beforeAll(async () => {
  initTheme("dark", false);
  // Exercise only the public factory. Unexpected initialization API access must fail,
  // rather than silently executing tools, reading settings, or activating codemode.
  const registration: Pick<ExtensionAPI, "registerTool"> = {
    registerTool(definition) {
      registrationCount++;
      const renderers = defineTool(definition);
      codemodeDefinition = renderers;
      nativeCodemodeRenderers = {
        renderShell: renderers.renderShell,
        renderCall: renderers.renderCall,
        renderResult: renderers.renderResult,
      };
    },
  };
  const localApi = new Proxy(registration, {
    get(target, key, receiver) {
      initializationAccesses.push(key);
      if (key !== "registerTool") throw new Error("Unexpected codemode initialization API: " + String(key));
      return Reflect.get(target, key, receiver);
    },
  }) as unknown as ExtensionAPI;
  await createCodemodeExtension()(localApi);
});

afterEach(() => {
  for (const overlay of overlays.splice(0)) overlay.dispose();
  for (const component of components) component.updateResult({ content: [], isError: false }, false);
  components.clear();
  clock?.restore();
  clock = undefined;
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createTool(name: string, args: Record<string, unknown>, options: ToolExecutionOptions = {}): ToolExecutionComponent {
  const component = SubagentPeekOverlay.prototype["createToolComponent"].call(
    { cwd, toolExecutionOptions: options, toolRenderUi: renderUi, nativeCodemodeRenderers } as any,
    name, "call-1", args,
  );
  components.add(component);
  return component;
}

function nativeDefinition(name: string): ToolRenderers {
  return name === "codemode" ? nativeCodemodeRenderers : nativeFactories.get(name)?.(cwd) ?? {};
}

function referenceTool(
  name: string, args: Record<string, unknown>, definition: ToolRenderers | undefined,
  options: ToolExecutionOptions = {},
): ToolExecutionComponent {
  const component = new ToolExecutionComponent(name, "call-1", args, options, definition, renderUi, cwd);
  component.setExpanded(false);
  components.add(component);
  return component;
}

function renderTool(component: ToolExecutionComponent, width = 100): string {
  return stripVTControlCharacters(component.render(width).join("\n"));
}

function expectNativeLines(component: ToolExecutionComponent, reference: ToolExecutionComponent): void {
  for (const width of widths) expect(component.render(width)).toEqual(reference.render(width));
}

function textResult<T extends object = {}>(text: string, extra: T = {} as T) {
  return { content: [{ type: "text" as const, text }], isError: false, ...extra };
}

function lines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => prefix + String(i + 1).padStart(3, "0")).join("\n");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const codeArgs = { code: 'const result = await tools.read({path: "中文目录/文件.ts"});\ntext(result);' };
const statuses = ["ok", "error", "cancelled", "running"] as const;
function calls(count = 4) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i), name: "nested_" + String(i + 1).padStart(3, "0"),
    args: 'path="中文目录/文件.ts" ' + "very_long_argument_".repeat(12),
    status: statuses[i % statuses.length], durationMs: i * 250,
    ...(i % 2 === 0 ? { cost: 0.00042 } : {}),
    ...(i % 4 === 1 ? { error: "caught nested failure\nmust not be expanded" } : {}),
  }));
}

function assistant(content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant", content, api: "test" as any, provider: "test", model: "fake",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 1000,
  };
}

function toolCall(name = "codemode", id = "call-1", args: JsonObject = codeArgs) {
  return { type: "toolCall" as const, name, id, arguments: args };
}

function history(messages: any[]): SessionManager {
  const session = SessionManager.inMemory(cwd);
  for (const message of messages) session.appendMessage(message);
  return session;
}

function toolRows(overlay: SubagentPeekOverlay): ToolExecutionComponent[] {
  return overlay["chatContainer"].children.filter((child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent);
}

function createOverlay(options: ToolExecutionOptions = {}, sessionFile?: string, wrapTui: (tui: TUI) => TUI = (tui) => tui) {
  const requestRender = mock(() => {});
  const done = mock((_navigation?: "previous" | "next") => {});
  const tui = wrapTui({ terminal: { rows: 90 }, requestRender } as unknown as TUI);
  // Run the real constructor/facade and fields; only suppress the socket boundary.
  const connect = spyOn(SubagentPeekOverlay.prototype as any, "connectSocket").mockImplementation(() => {});
  let overlay: SubagentPeekOverlay;
  try {
    overlay = new SubagentPeekOverlay(tui, { fg: (_color: string, text: string) => text } as Theme, {
      id: "peek-unit-" + randomUUID(), taskName: "rendering", provider: "test",
      modelId: "fake", model: "test:fake", thinking: "off", cwd,
      sessionFile: sessionFile ?? join(tmpdir(), "peek-absent-" + randomUUID() + ".jsonl"),
    } as any, done, nativeCodemodeRenderers, options);
  } finally {
    connect.mockRestore();
  }
  overlays.push(overlay);
  return { overlay, requestRender, done, tui };
}

function controlledClock() {
  let now = 10_000;
  let nextId = 1;
  const timers = new Map<any, { callback: () => void; delay: number | undefined }>();
  const date = spyOn(Date, "now").mockImplementation(() => now);
  const set = spyOn(globalThis, "setInterval").mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const id = nextId++;
    timers.set(id, { callback: () => callback(...args), delay });
    return id;
  }) as any);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((id: any) => { timers.delete(id); }) as any);
  return {
    timers, set, clear,
    advance(ms: number) { now += ms; },
    nativeTimers() { return [...timers].filter(([, timer]) => timer.delay === 1000); },
    restore() { clear.mockRestore(); set.mockRestore(); date.mockRestore(); },
  };
}

function missingEditArgs() {
  const directory = fs.mkdtempSync(join(tmpdir(), "pi-peek-edit-"));
  temporaryDirectories.push(directory);
  return freeze({ path: join(directory, "missing.txt"), edits: [{ oldText: "before", newText: "after" }] });
}

async function waitForEditPreview(component: ToolExecutionComponent): Promise<void> {
  // Observe the public output of a real native FS preview, not private renderer state.
  // Date.now/setInterval are controlled, but these event-loop/FS waits are genuine.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (renderTool(component).includes("ENOENT")) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(renderTool(component)).toContain("ENOENT");
}

function start(overlay: SubagentPeekOverlay, name = "codemode", args: Record<string, unknown> = codeArgs) {
  overlay["handleEvent"]({ type: "tool_execution_start", toolCallId: "call-1", toolName: name, args });
  return overlay["pendingTools"].get("call-1")!.component;
}

function progress(overlay: SubagentPeekOverlay, partialResult = textResult("", { details: { calls: calls() } })) {
  overlay["handleEvent"]({ type: "tool_execution_update", toolCallId: "call-1", partialResult });
}

describe("peek tool rendering", () => {
  test.each(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"])(
    "passes an explicit built-in definition for %s",
    (name) => {
      const component = createTool(name, {});
      expect(component["toolDefinition"]).toHaveProperty("name", name);
      expect(component["toolDefinition"]?.renderCall).toBeFunction();
      expect(component["toolDefinition"]?.renderResult).toBeFunction();
      expect(component["expanded"]).toBe(false);
      expectNativeLines(component, referenceTool(name, {}, nativeDefinition(name)));
    },
  );

  test("read shows only its compact header instead of raw arguments and the full file", () => {
    const component = createTool("read", { path: "src/catalog.rs", offset: 100, limit: 45 });
    component.updateResult({
      content: [{ type: "text", text: Array.from({ length: 45 }, (_, i) => "file_line_" + (i + 1)).join("\n") }],
      isError: false,
    });

    const text = renderTool(component);
    expect(text).toContain("src/catalog.rs");
    expect(text).not.toContain('"path":');
    expect(text).toContain("100-144");
    expect(text).not.toContain("file_line_");
  });

  test("bash output stays collapsed while streaming and after completion", () => {
    const component = createTool("bash", { command: "printf output" });
    const result = {
      content: [{ type: "text" as const, text: Array.from({ length: 30 }, (_, i) => "output_line_" + (i + 1)).join("\n") }],
      isError: false,
    };

    for (const isPartial of [true, false]) {
      component.updateResult(result, isPartial);
      const text = renderTool(component);
      expect(text).toContain("printf output");
      expect(text).not.toContain('"command":');
      expect(text).not.toContain("output_line_1");
      expect(text).toContain("output_line_30");
      expect(text).toContain("25 earlier lines");
    }
  });
});

describe("fixed native collapsed rendering", () => {
  test("collects codemode renderers through the public factory without execution or activation", () => {
    expect(initializationAccesses).toEqual(["registerTool"]);
    expect(registrationCount).toBe(1);
    expect(codemodeDefinition.name).toBe("codemode");
    expect(codemodeDefinition.defaultActive).toBe(false);
    expect(nativeCodemodeRenderers.renderCall).toBeFunction();
    expect(nativeCodemodeRenderers.renderResult).toBeFunction();
    const component = createTool("codemode", codeArgs);
    expect(component["toolDefinition"]).toBe(nativeCodemodeRenderers);
    expect(Object.keys(component["toolDefinition"]!).sort()).toEqual(["renderCall", "renderResult", "renderShell"]);
  });

  test("the central factory explicitly fixes expanded=false for all renderer selections", () => {
    const expanded = spyOn(ToolExecutionComponent.prototype, "setExpanded");
    try {
      for (const name of [...nativeFactories.keys(), "codemode", "tool_search", "unknown_tool"]) {
        const callsBefore = expanded.mock.calls.length;
        const component = createTool(name, name === "codemode" ? codeArgs : {});
        expect(expanded.mock.calls.length).toBe(callsBefore + 1);
        expect(expanded).toHaveBeenLastCalledWith(false);
        expect(component["expanded"]).toBe(false);
      }
    } finally {
      expanded.mockRestore();
    }
  });

  test.each(["bash", "powershell"])("%s retains long commands and native output tails at every width", (name) => {
    const args = freeze({ command: lines("echo 中文命令_", 40) });
    const result = freeze(textResult(lines("shell_output_", 100), { durationMs: 4250 }));
    const original = structuredClone({ args, result });
    const component = createTool(name, args);
    const reference = referenceTool(name, args, nativeDefinition(name));
    component.setArgsComplete();
    reference.setArgsComplete();
    for (const partial of [true, false]) {
      component.updateResult(result, partial);
      reference.updateResult(result, partial);
      expectNativeLines(component, reference);
      const text = renderTool(component);
      expect(text).toContain("中文命令_040");
      expect(text).not.toContain("shell_output_001");
      expect(text).toContain("shell_output_100");
    }
    expect({ args, result }).toEqual(original);
  });

  test("codemode long Chinese code, calls and output exactly match native previews, not an expanded control", () => {
    const args = freeze({ code: "// @options: {\"max_output_tokens\": 4000}\n" + lines('text("中文代码"); // code_', 30) });
    const result = freeze(textResult(lines("script_output_", 100), {
      details: { calls: calls(13), fullOutputPath: "/tmp/full-codemode-output.txt", retained: "original details" },
      durationMs: 4250,
    }));
    const original = structuredClone({ args, result });
    const component = createTool("codemode", args);
    const reference = referenceTool("codemode", args, nativeCodemodeRenderers);
    component.updateResult(result);
    reference.updateResult(result);
    expectNativeLines(component, reference);
    const text = renderTool(component);
    expect(text).toContain("中文代码");
    expect(text).not.toContain("code_030");
    expect(text).not.toContain("nested_001");
    expect(text).toContain("nested_013");
    expect(text).toContain("script_output_001");
    expect(text).not.toContain("script_output_100");
    expect(text).toContain("Full output: /tmp/full-codemode-output.txt");
    expect(text).toContain("Model calls:");
    expect(text).toContain("Took 4.3s");
    reference.setExpanded(true);
    expect(component.render(80)).not.toEqual(reference.render(80));
    expect(renderTool(reference)).toContain("script_output_100");
    expect(component["result"]?.details).toBe(result.details);
    expect({ args, result }).toEqual(original);
  });

  test.each(statuses)("codemode preserves native %s status and styling", (status) => {
    const partial = status === "running";
    const result = freeze(textResult("final text", {
      isError: status === "error",
      details: { calls: [{ name: "内层工具", args: "参数", status, durationMs: 125, error: "nested error" }] },
      durationMs: 125,
    }));
    const component = createTool("codemode", codeArgs);
    const reference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    component.updateResult(result, partial);
    reference.updateResult(result, partial);
    expectNativeLines(component, reference);
    expect(renderTool(component)).toContain({ ok: "✓", error: "✗", cancelled: "⊘", running: "…" }[status] + " 内层工具");
    expect(renderTool(component).includes("final text")).toBe(!partial);
  });

  test("caught nested errors do not turn a successful parent into an error", () => {
    const result = freeze(textResult("Promise.allSettled handled the failures", {
      details: { calls: calls(3) }, durationMs: 1500,
    }));
    const component = createTool("codemode", codeArgs);
    const reference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    component.updateResult(result);
    reference.updateResult(result);
    expectNativeLines(component, reference);
    const text = renderTool(component);
    for (const symbol of ["✓", "✗", "⊘"]) expect(text).toContain(symbol);
    expect(text).not.toContain("caught nested failure");
    expect(component["result"]?.isError).toBe(false);
    expect(component["result"]).toBe(result);
    expect(result.details.calls[1].status).toBe("error");
  });

  test.each([
    ["no output", { content: [], isError: false, details: { calls: [] } }],
    ["header only", textResult("Script completed\nWall time 0.1 seconds\nOutput:\n")],
    ["header with output", { content: [
      { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "text", text: "中文 script output" },
    ], isError: false }],
    ["old result without details", textResult("old output")],
    ["old details without calls", textResult("old output", { details: { nestedCalls: [{ status: "error", name: "not-a-call" }] } })],
    ["error without calls", textResult("Script rejected: invalid options", { isError: true })],
  ])("codemode %s retains native behavior without invented nested states", (_name, result) => {
    const frozen = freeze(result);
    const original = structuredClone(frozen);
    const component = createTool("codemode", codeArgs);
    const reference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    component.updateResult(frozen);
    reference.updateResult(frozen);
    expectNativeLines(component, reference);
    expect(renderTool(component)).not.toMatch(/[✓✗⊘]/);
    expect(renderTool(component)).not.toContain("Script completed");
    expect(frozen).toEqual(original);
  });

  test.each(["unregistered_extension_tool", "tool_search"])("%s uses native generic logical-line fallback, not undefined/full rendering", (name) => {
    const args = freeze({ query: "中文 search " + "long argument ".repeat(40), limit: 30 });
    const result = freeze(textResult(lines("generic_output_", 40)));
    const component = createTool(name, args);
    const reference = referenceTool(name, args, {});
    const undefinedControl = referenceTool(name, args, undefined);
    for (const tool of [component, reference, undefinedControl]) tool.updateResult(result);
    expect(component["toolDefinition"]).toEqual({});
    expectNativeLines(component, reference);
    const text = renderTool(component);
    expect(text).toContain("generic_output_001");
    expect(text).not.toContain("generic_output_040");
    expect(text).toContain("more lines");
    expect(renderTool(undefinedControl)).toContain("generic_output_040");
    expect(component.render(80)).not.toEqual(undefinedControl.render(80));

    // A single logical line may be very tall: do not add a visual-line cap to generic fallback.
    const json = textResult(JSON.stringify({ data: "中文long_json_value_".repeat(400), end: "JSON_TAIL_SENTINEL" }));
    for (const tool of [component, reference]) tool.updateResult(json);
    expectNativeLines(component, reference);
    expect(renderTool(component, 38).replace(/\s/g, "")).toContain("JSON_TAIL_SENTINEL");
    expect(component.render(38).length).toBeGreaterThan(component.render(100).length);
    const codemode = createTool("codemode", codeArgs);
    const nativeCodemode = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    codemode.updateResult(json);
    nativeCodemode.updateResult(json);
    expectNativeLines(codemode, nativeCodemode);
    expect(renderTool(codemode, 38)).not.toContain("JSON_TAIL_SENTINEL");
  });

  test.each(["codemode", "tool_search", "read"])("%s respects native images, imageWidthCells and outputPad settings", (name) => {
    const previousCaps = { ...getCapabilities() };
    const previousCells = { ...getCellDimensions() };
    try {
      // iTerm2 sequences have no random Kitty image IDs, so raw equality remains meaningful.
      setCapabilities({ images: "iterm2", hyperlinks: false, trueColor: true });
      setCellDimensions({ widthPx: 8, heightPx: 16 });
      const args = name === "codemode" ? codeArgs : { path: "中文/图片.png" };
      const result = freeze({
        content: [
          { type: "text", text: "image result" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" },
        ],
        isError: false,
      });
      const original = structuredClone(result);
      const outputs: string[][] = [];
      for (const options of [{}, { showImages: false, imageWidthCells: 7, outputPad: 0 }, { showImages: true, imageWidthCells: 13, outputPad: 3 }]) {
        const component = createTool(name, args, options);
        const reference = referenceTool(name, args, nativeDefinition(name), options);
        component.updateResult(result);
        reference.updateResult(result);
        expectNativeLines(component, reference);
        for (const key of ["showImages", "imageWidthCells", "outputPad"] as const) expect(component[key]).toBe(reference[key]);
        outputs.push(component.render(80));
      }
      expect(outputs[0].join("\n")).toContain("\x1b]1337;File=");
      expect(outputs[1].join("\n")).not.toContain("\x1b]1337;File=");
      expect(outputs[2].join("\n")).toContain("\x1b]1337;File=");
      expect(outputs[1]).not.toEqual(outputs[2]);
      expect(result).toEqual(original);
    } finally {
      setCapabilities(previousCaps);
      setCellDimensions(previousCells);
    }
  });
});

describe("overlay creation paths and native lifecycle", () => {
  beforeEach(() => { clock = controlledClock(); });

  test("long task names and the footer fit narrow overlay widths without losing their border or status", () => {
    const { overlay } = createOverlay();
    overlay["info"].taskName = "long-task/".repeat(30) + "review";
    overlay["status"] = "tool";
    for (const width of [22, 38, 50, 80, 100]) {
      const lines = overlay.render(width);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      const plain = lines.map(stripVTControlCharacters);
      expect(plain[0]).toStartWith("╭");
      expect(plain[0]).toEndWith("╮");
      expect(plain[0]).toContain("◑ tool");
      expect(plain.at(-2)).toStartWith("│");
      expect(plain.at(-2)).toEndWith("│");
    }
  });

  test("native refresh facade never writes through the real UI proxy to its shared TUI", () => {
    let target!: TUI;
    const forwardedSet = mock((object: TUI, key: PropertyKey, value: unknown) => Reflect.set(object, key, value));
    const { overlay, requestRender } = createOverlay({}, undefined, (tui) => {
      target = tui;
      // Pi forwards writes to its shared renderer and binds method reads to that renderer.
      return new Proxy(tui, {
        get(object, key) {
          const value = Reflect.get(object, key);
          return typeof value === "function" ? value.bind(object) : value;
        },
        set: forwardedSet,
      });
    });
    expect(forwardedSet).not.toHaveBeenCalled();
    expect(target.requestRender).toBe(requestRender);
    expect(Object.hasOwn(overlay["toolRenderUi"], "requestRender")).toBe(true);
    const component = start(overlay);
    progress(overlay);
    overlay.render(82);
    const requests = requestRender.mock.calls.length;
    clock!.nativeTimers()[0][1].callback();
    expect(requestRender.mock.calls.length).toBe(requests + 1);
    expect(overlay["cachedLines"]).toBeNull();
    expect(target.requestRender).toBe(requestRender);
    expect(forwardedSet).not.toHaveBeenCalled();
    expect(component["expanded"]).toBe(false);
    overlay.dispose();
  });

  test("history replays without live args-complete or execution-start hooks, including aborted calls", () => {
    const { overlay } = createOverlay();
    const completed = freeze(textResult("persisted output", { details: { calls: calls(3) }, durationMs: 2400 }));
    overlay["sessionManager"] = history([
      assistant([toolCall(), toolCall("powershell", "pending", { command: "echo history" } as any)]),
      { role: "toolResult", toolCallId: "call-1", toolName: "codemode", ...completed, timestamp: 1001 },
      { ...assistant([toolCall("read", "aborted", { path: "file.ts" } as any)]), stopReason: "aborted", errorMessage: "Operation aborted" },
    ]);
    overlay["rebuildChat"]();
    expect(toolRows(overlay)).toHaveLength(3);
    for (const component of toolRows(overlay)) {
      expect(component["expanded"]).toBe(false);
      expect(component["argsComplete"]).toBe(false);
      expect(component["executionStarted"]).toBe(false);
      expect(renderTool(component)).not.toContain("Elapsed");
    }
    const reference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    reference.updateResult(completed);
    expectNativeLines(toolRows(overlay)[0], reference);
    expect(overlay["pendingTools"].get("pending")!.executing).toBe(false);
    expect(overlay["pendingTools"].has("aborted")).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(0);
  });

  test.each([
    ["history", "aborted"], ["history", "error"], ["history", "success"],
    ["sync", "aborted"], ["sync", "error"], ["sync", "success"],
  ] as const)("%s %s edit replay does not invent a missing-file preview or alter recorded data", async (source, status) => {
    const { overlay } = createOverlay();
    const args = missingEditArgs();
    const recorded = status === "success" ? "Previously completed edit" : "Recorded " + status + " result";
    const result = freeze(textResult(recorded, {
      isError: status !== "success", durationMs: 1500, details: { retained: "old metadata without diff" },
    }));
    const original = structuredClone({ args, result });
    const expected = source === "history" && status !== "success"
      ? textResult(recorded, { isError: true })
      : result;
    if (source === "history") {
      const message = freeze({
        ...assistant([toolCall("edit", "call-1", args)]),
        stopReason: status === "success" ? "toolUse" : status,
        errorMessage: status === "success" ? undefined : recorded,
      });
      overlay["sessionManager"] = history([
        message,
        ...(status === "success" ? [{
          role: "toolResult", toolCallId: "call-1", toolName: "edit", ...result, timestamp: 1001,
        }] : []),
      ]);
      overlay["rebuildChat"]();
    } else {
      overlay["handleEvent"](freeze({ type: "sync", status: "done", activeTools: [{
        toolCallId: "call-1", toolName: "edit", args, result, isError: result.isError,
      }] }));
    }
    const component = toolRows(overlay)[0];
    const reference = referenceTool("edit", args, nativeDefinition("edit"));
    // Native history replay only supplies the recorded result, never the live hook.
    reference.updateResult(expected);
    const before = widths.map((width) => component.render(width));

    // This positive control proves that valid args really would read today's missing file.
    // Waiting for its async callback prevents a synchronous-only regression from passing.
    const liveControl = referenceTool("edit", args, nativeDefinition("edit"));
    liveControl.setArgsComplete();
    liveControl.updateResult(expected);
    await waitForEditPreview(liveControl);
    expect(renderTool(liveControl)).toContain("Could not edit file");

    expectNativeLines(component, reference);
    for (const [index, width] of widths.entries()) expect(component.render(width)).toEqual(before[index]);
    expect(component["argsComplete"]).toBe(false);
    expect(component["executionStarted"]).toBe(false);
    expect(component["expanded"]).toBe(false);
    expect(component["result"]?.content).toEqual(expected.content);
    expect(component["result"]?.isError).toBe(expected.isError);
    expect(renderTool(component)).not.toMatch(/ENOENT|Could not edit file|preview error/i);
    expect(overlay["pendingTools"].size).toBe(0);
    expect(fs.existsSync(args.path)).toBe(false);
    overlay.dispose();
    expect({ args, result }).toEqual(original);
  });

  test.each(["message_end", "execution_start", "sync-running"])("%s edit keeps the genuine live args-complete preview", async (source) => {
    const { overlay, requestRender } = createOverlay();
    const args = missingEditArgs();
    const original = structuredClone(args);
    if (source === "message_end") {
      const message = assistant([toolCall("edit", "call-1", args)]);
      overlay["handleEvent"]({ type: "message_start", message: assistant() });
      overlay["handleEvent"]({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 } });
      expect(overlay["pendingTools"].get("call-1")!.component["argsComplete"]).toBe(false);
      overlay["handleEvent"]({ type: "message_end", message });
    } else if (source === "execution_start") {
      start(overlay, "edit", args);
    } else {
      overlay["handleEvent"]({ type: "sync", status: "tool", activeTools: [{
        toolCallId: "call-1", toolName: "edit", args,
      }] });
    }
    const pending = overlay["pendingTools"].get("call-1")!;
    const component = pending.component;
    expect(component["argsComplete"]).toBe(true);
    expect(component["executionStarted"]).toBe(source !== "message_end");
    expect(pending.executing).toBe(source !== "message_end");
    expect(component["expanded"]).toBe(false);
    const reference = referenceTool("edit", args, nativeDefinition("edit"));
    reference.setArgsComplete();
    if (source !== "message_end") reference.markExecutionStarted();
    const requests = requestRender.mock.calls.length;
    await Promise.all([waitForEditPreview(component), waitForEditPreview(reference)]);
    expect(requestRender.mock.calls.length).toBeGreaterThan(requests);
    expectNativeLines(component, reference);
    expect(component["result"]).toBeUndefined();
    expect(fs.existsSync(args.path)).toBe(false);
    expect(args).toEqual(original);
  });

  test("message_update creation and message_end args completion wait for actual execution evidence", () => {
    const { overlay } = createOverlay();
    const message = assistant([toolCall()]);
    overlay["handleEvent"]({ type: "message_start", message: assistant() });
    overlay["handleEvent"]({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 } });
    const component = overlay["pendingTools"].get("call-1")!.component;
    expect(overlay["pendingTools"].get("call-1")!.executing).toBe(false);
    expect(component).toBeInstanceOf(ToolExecutionComponent);
    expect(component["toolDefinition"]).toBe(nativeCodemodeRenderers);
    expect(component["expanded"]).toBe(false);
    expect(component["argsComplete"]).toBe(false);
    expect(component["executionStarted"]).toBe(false);
    overlay["handleEvent"]({ type: "message_end", message });
    expect(component["argsComplete"]).toBe(true);
    expect(component["executionStarted"]).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(0);
    expect(start(overlay)).toBe(component);
    expect(overlay["pendingTools"].get("call-1")!.executing).toBe(true);
    expect(component["executionStarted"]).toBe(true);
    progress(overlay);
    expect(clock!.nativeTimers()).toHaveLength(1);
    const before = component.render(80);
    for (const key of ["\x0f", "\r", " "]) overlay.handleInput(key);
    expect(component["expanded"]).toBe(false);
    expect(component.render(80)).toEqual(before);
    expect((overlay as any).handleMouse).toBeUndefined();
  });

  test.each(["codemode", "powershell", "tool_search"])("direct %s execution creates a fixed collapsed, args-complete, started native instance", (name) => {
    const options = { showImages: false, imageWidthCells: 17, outputPad: 3 };
    const { overlay } = createOverlay(options);
    const args = name === "codemode" ? codeArgs : { command: "echo 中文", query: "search" };
    const component = start(overlay, name, args);
    expect(component).toBeInstanceOf(ToolExecutionComponent);
    expect(component["expanded"]).toBe(false);
    expect(component["argsComplete"]).toBe(true);
    expect(component["executionStarted"]).toBe(true);
    expect(overlay["pendingTools"].get("call-1")!.executing).toBe(true);
    const reference = referenceTool(name, args, nativeDefinition(name), options);
    reference.setArgsComplete();
    reference.markExecutionStarted();
    const result = freeze(textResult("final result", { durationMs: 100 }));
    overlay["handleEvent"]({ type: "tool_execution_end", toolCallId: "call-1", result, isError: true, durationMs: 6543 });
    reference.updateResult({ ...result, isError: true, durationMs: 6543 });
    expectNativeLines(component, reference);
    expect(component["result"]?.durationMs).toBe(6543);
    expect(component["result"]?.isError).toBe(true);
    expect(result.durationMs).toBe(100);
    expect(result.isError).toBe(false);
    expect(overlay["pendingTools"].size).toBe(0);
  });

  test("sync partial assistant arguments alone do not imply execution or completed arguments", () => {
    const { overlay } = createOverlay();
    overlay["handleEvent"]({ type: "sync", status: "calling", partialMessage: assistant([toolCall()]), activeTools: [] });
    const pending = overlay["pendingTools"].get("call-1")!;
    expect(pending.executing).toBe(false);
    expect(pending.component["expanded"]).toBe(false);
    expect(pending.component["argsComplete"]).toBe(false);
    expect(pending.component["executionStarted"]).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(0);
    expectNativeLines(pending.component, referenceTool("codemode", codeArgs, nativeCodemodeRenderers));
  });

  test("sync recovers running evidence, reuses history rows, and does not start final rows", () => {
    const { overlay } = createOverlay();
    overlay["sessionManager"] = history([assistant([toolCall()])]);
    const partial = freeze(textResult("partial text is not codemode output", { details: { calls: calls() } }));
    const final = freeze(textResult("sync final", { details: { calls: calls(3) }, durationMs: 3200 }));
    overlay["handleEvent"]({ type: "sync", status: "tool", activeTools: [
      { toolCallId: "call-1", toolName: "codemode", args: codeArgs, partialResult: partial },
      { toolCallId: "final", toolName: "codemode", args: codeArgs, result: final },
      { toolCallId: "no-partial", toolName: "tool_search", args: { query: "中文" } },
    ] });
    const rows = toolRows(overlay);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row["expanded"]).toBe(false);
    expect(rows[0]["argsComplete"]).toBe(true);
    expect(rows[1]["argsComplete"]).toBe(false);
    expect(rows[2]["argsComplete"]).toBe(true);
    expect(rows[0]["executionStarted"]).toBe(true);
    expect(rows[1]["executionStarted"]).toBe(false);
    expect(rows[2]["executionStarted"]).toBe(true);
    expect(overlay["pendingTools"].get("call-1")!.executing).toBe(true);
    expect(overlay["pendingTools"].get("no-partial")!.executing).toBe(true);
    expect(overlay["pendingTools"].has("final")).toBe(false);
    expect(rows[1]["result"]?.durationMs).toBe(3200);
    expect(clock!.nativeTimers()).toHaveLength(1);
    const reference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    reference.setArgsComplete();
    reference.markExecutionStarted();
    reference.updateResult(partial, true);
    expectNativeLines(rows[0], reference);
    const finalReference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    finalReference.updateResult(final);
    expectNativeLines(rows[1], finalReference);
  });

  test("a partial execution update can start a reconstructed row, but history alone cannot", () => {
    const { overlay } = createOverlay();
    overlay["sessionManager"] = history([assistant([toolCall()])]);
    overlay["rebuildChat"]();
    const component = overlay["pendingTools"].get("call-1")!.component;
    expect(overlay["pendingTools"].get("call-1")!.executing).toBe(false);
    expect(component["executionStarted"]).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(0);
    progress(overlay);
    expect(overlay["pendingTools"].get("call-1")!.component).toBe(component);
    expect(overlay["pendingTools"].get("call-1")!.executing).toBe(true);
    expect(component["executionStarted"]).toBe(true);
    expect(component["argsComplete"]).toBe(true);
    expect(component["expanded"]).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(1);
  });

  test.each(["live", "sync", "history"])("%s final results use identical native lines and preserve full original data", (path) => {
    const { overlay } = createOverlay();
    const result = freeze(textResult(lines("persisted_中文_", 100), {
      details: { calls: calls(12), fullOutputPath: "/tmp/full-output.txt" }, durationMs: 7200,
    }));
    const original = structuredClone(result);
    if (path === "live") {
      start(overlay);
      overlay["handleEvent"]({ type: "tool_execution_end", toolCallId: "call-1", result });
    } else if (path === "sync") {
      overlay["handleEvent"]({ type: "sync", activeTools: [{ toolCallId: "call-1", toolName: "codemode", args: codeArgs, result }] });
    } else {
      overlay["sessionManager"] = history([assistant([toolCall()]),
        { role: "toolResult", toolCallId: "call-1", toolName: "codemode", ...result, timestamp: 1001 }]);
      overlay["rebuildChat"]();
    }
    const component = toolRows(overlay)[0];
    const reference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    if (path === "live") reference.setArgsComplete();
    reference.updateResult(result);
    expectNativeLines(component, reference);
    expect(component["expanded"]).toBe(false);
    expect(component["argsComplete"]).toBe(path === "live");
    expect(component["result"]?.durationMs).toBe(7200);
    overlay.dispose();
    expect(result).toEqual(original);
  });

  test.each(["codemode", "bash", "powershell"])("%s native refresh invalidates overlay cachedLines and final duration stops refresh", (name) => {
    const { overlay, requestRender, tui } = createOverlay();
    const originalRequestRender = tui.requestRender;
    const args = name === "codemode" ? codeArgs : { command: "echo 中文" };
    const component = start(overlay, name, args);
    progress(overlay);
    const [timerId, timer] = clock!.nativeTimers()[0];
    expect(clock!.nativeTimers()).toHaveLength(1);
    expect([...clock!.timers.values()].map((entry) => entry.delay).sort()).toEqual([200, 1000].sort());
    const reference = referenceTool(name, args, nativeDefinition(name));
    reference.setArgsComplete();
    reference.markExecutionStarted();
    reference.updateResult(textResult("", { details: { calls: calls() } }), true);
    const referenceTimer = clock!.nativeTimers().find(([id]) => id !== timerId)![1];

    expect(stripVTControlCharacters(overlay.render(82).join("\n"))).toContain("Elapsed 0.0s");
    const cached = overlay["cachedLines"];
    expect(overlay["cachedWidth"]).toBe(80);
    const requests = requestRender.mock.calls.length;
    clock!.advance(4200);
    timer.callback();
    expect(overlay["cachedLines"]).toBeNull();
    expect(overlay["cachedWidth"]).toBeNull();
    expect(requestRender.mock.calls.length).toBe(requests + 1);
    expect(tui.requestRender).toBe(originalRequestRender);
    referenceTimer.callback();
    expect(stripVTControlCharacters(overlay.render(82).join("\n"))).toContain("Elapsed 4.2s");
    expect(overlay["cachedLines"]).not.toBe(cached);
    expect(component.render(80)).toEqual(reference.render(80));

    const final = freeze(textResult("completed", { durationMs: 7654 }));
    overlay["handleEvent"]({ type: "tool_execution_end", toolCallId: "call-1", result: final });
    reference.updateResult(final);
    expect(clock!.clear).toHaveBeenCalledWith(timerId);
    expect(clock!.nativeTimers()).toHaveLength(0);
    expectNativeLines(component, reference);
    expect(renderTool(component)).toContain("Took 7.7s");
    clock!.advance(9000);
    component.invalidate();
    expectNativeLines(component, reference);
    expect(renderTool(component)).not.toContain("Elapsed");
  });

  test("resize and theme invalidation drop outer caches and still match same-theme native lines", () => {
    const { overlay } = createOverlay();
    const component = start(overlay);
    const result = textResult(lines("中文结果_", 30), { durationMs: 1100 });
    overlay["handleEvent"]({ type: "tool_execution_end", toolCallId: "call-1", result });
    const reference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    reference.setArgsComplete();
    reference.updateResult(result);
    try {
      for (const theme of ["light", "dark"]) {
        initTheme(theme, false);
        overlay.invalidate();
        reference.invalidate();
        expect(overlay["cachedLines"]).toBeNull();
        for (const width of widths) {
          overlay.render(width + 2);
          expect(overlay["cachedWidth"]).toBe(width);
          expect(component.render(width)).toEqual(reference.render(width));
        }
      }
    } finally {
      initTheme("dark", false);
    }
  });

  test("rebuild releases discarded native renderers without changing their original results", () => {
    const { overlay } = createOverlay();
    const component = start(overlay);
    const partial = freeze(textResult("", { details: { calls: calls() } }));
    const original = structuredClone(partial);
    progress(overlay, partial);
    const [timerId] = clock!.nativeTimers()[0];
    overlay["rebuildChat"]();
    expect(clock!.clear).toHaveBeenCalledWith(timerId);
    expect(clock!.nativeTimers()).toHaveLength(0);
    expect(component["isPartial"]).toBe(false);
    expect(component["result"]).toEqual({ content: [], isError: false });
    expect(toolRows(overlay)).toHaveLength(0);
    expect(overlay["pendingTools"].size).toBe(0);
    overlay["rebuildChat"]();
    expect(clock!.nativeTimers()).toHaveLength(0);
    expect(partial).toEqual(original);
  });

  test("replacement of a provisional streaming call releases its native refresh resource", () => {
    const { overlay } = createOverlay();
    overlay["handleEvent"]({ type: "message_start", message: assistant() });
    overlay["handleEvent"]({
      type: "message_update", message: assistant([toolCall("codemode", "temporary")]),
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0 },
    });
    overlay["handleEvent"]({ type: "tool_execution_start", toolCallId: "temporary", toolName: "codemode", args: codeArgs });
    overlay["handleEvent"]({ type: "tool_execution_update", toolCallId: "temporary", partialResult: textResult("", { details: { calls: calls() } }) });
    const [timerId] = clock!.nativeTimers()[0];
    overlay["handleEvent"]({
      type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: toolCall() },
    });
    expect(clock!.clear).toHaveBeenCalledWith(timerId);
    expect(clock!.nativeTimers()).toHaveLength(0);
    expect(toolRows(overlay)).toHaveLength(1);
    expect(overlay["pendingTools"].has("temporary")).toBe(false);
    const replacement = overlay["pendingTools"].get("call-1")!.component;
    expect(overlay["pendingTools"].get("call-1")!.executing).toBe(false);
    expect(replacement["expanded"]).toBe(false);
    expect(replacement["argsComplete"]).toBe(false);
    expect(replacement["executionStarted"]).toBe(false);
  });

  test.each([
    ["dispose", undefined, undefined], ["close", "q", undefined],
    ["previous agent", "\x1b[D", "previous"], ["next agent", "\x1b[C", "next"],
  ])("%s releases timers; repeat disposal and late events, polls and renderer callbacks are inert", (_name, key, navigation) => {
    const { overlay, requestRender, done } = createOverlay();
    start(overlay);
    const partial = freeze(textResult("", { details: { calls: calls() } }));
    progress(overlay, partial);
    const [timerId, nativeTimer] = clock!.nativeTimers()[0];
    const pollTimer = [...clock!.timers.values()].find((entry) => entry.delay === 200)!;
    const destroy = mock(() => {});
    overlay["socket"] = { destroy } as any;
    overlay.render(82);
    if (key) overlay.handleInput(key);
    else overlay.dispose();
    expect(clock!.clear).toHaveBeenCalledWith(timerId);
    expect(clock!.timers.size).toBe(0);
    expect(destroy).toHaveBeenCalledTimes(1);
    if (navigation) expect(done).toHaveBeenCalledWith(navigation);
    else if (key) expect(done).toHaveBeenCalledWith();
    else expect(done).not.toHaveBeenCalled();
    const requests = requestRender.mock.calls.length;
    const intervalCalls = clock!.set.mock.calls.length;
    overlay.dispose();
    overlay["handleEvent"]({ type: "tool_execution_start", toolCallId: "late", toolName: "codemode", args: codeArgs });
    overlay["handleEvent"]({ type: "sync", activeTools: [{ toolCallId: "late", toolName: "codemode", args: codeArgs, partialResult: partial }] });
    pollTimer.callback();
    overlay["poll"]();
    nativeTimer.callback();
    overlay["toolRenderUi"].requestRender();
    overlay.invalidate();
    overlay.handleInput("\x1b[C");
    expect(overlay.render(82)).toEqual([]);
    expect(toolRows(overlay)).toHaveLength(0);
    expect(overlay["pendingTools"].size).toBe(0);
    expect(overlay["cachedLines"]).toBeNull();
    expect(requestRender.mock.calls.length).toBe(requests);
    expect(clock!.set.mock.calls.length).toBe(intervalCalls);
    expect(clock!.timers.size).toBe(0);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(done.mock.calls.length).toBe(key ? 1 : 0);
  });

  test("connected historical pending rows without execution evidence do not block file recovery", () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "pi-peek-history-"));
    temporaryDirectories.push(directory);
    const session = SessionManager.create(cwd, directory);
    session.appendMessage(assistant([toolCall()]));
    const { overlay } = createOverlay({}, session.getSessionFile()!);
    const historical = overlay["pendingTools"].get("call-1")!;
    expect(historical.executing).toBe(false);
    expect(historical.component["executionStarted"]).toBe(false);
    overlay["socket"] = { connecting: false, destroyed: false, destroy() {} } as any;
    const final = textResult("late persisted result", { durationMs: 4600 });
    session.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "codemode", ...final, timestamp: 1001 });
    overlay["poll"]();
    expect(overlay["pendingTools"].size).toBe(0);
    expect(overlay["historyDirty"]).toBe(false);
    expect(clock!.nativeTimers()).toHaveLength(0);
    const restored = toolRows(overlay)[0];
    expect(restored).not.toBe(historical.component);
    const reference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    reference.updateResult(final);
    expectNativeLines(restored, reference);
  });

  test("deferred history is consumed after execution ends without rereading an unchanged file", () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "pi-peek-deferred-"));
    temporaryDirectories.push(directory);
    const session = SessionManager.create(cwd, directory);
    session.appendMessage(assistant([toolCall()]));
    const file = session.getSessionFile()!;
    const { overlay, requestRender } = createOverlay({}, file);
    const component = start(overlay);
    progress(overlay);
    overlay["socket"] = { connecting: false, destroyed: false, destroy() {} } as any;
    const final = freeze(textResult("persisted before end event", { durationMs: 5100 }));
    session.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "codemode", ...final, timestamp: 1001 });
    const load = spyOn(overlay as any, "loadSession");
    try {
      const requests = requestRender.mock.calls.length;
      overlay["poll"]();
      expect(overlay["historyDirty"]).toBe(true);
      expect(overlay["pendingTools"].get("call-1")!.component).toBe(component);
      expect(load).toHaveBeenCalledTimes(1);
      expect(requestRender.mock.calls.length).toBe(requests);
      overlay["poll"]();
      expect(load).toHaveBeenCalledTimes(1);
      const size = fs.statSync(file).size;
      overlay["handleEvent"]({ type: "tool_execution_end", toolCallId: "call-1", result: final });
      expect(clock!.nativeTimers()).toHaveLength(0);
      overlay["poll"]();
      expect(load).toHaveBeenCalledTimes(1);
      expect(fs.statSync(file).size).toBe(size);
      expect(overlay["historyDirty"]).toBe(false);
      const restored = toolRows(overlay)[0];
      expect(restored).not.toBe(component);
      expect(restored["executionStarted"]).toBe(false);
      expect(restored["argsComplete"]).toBe(false);
      const reference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
      reference.updateResult(final);
      expectNativeLines(restored, reference);
    } finally {
      load.mockRestore();
    }
  });

  test.each(["disconnected", "destroyed", "connecting"])("poll preserves live pending rows but %s socket state permits file fallback and releases timers", (state) => {
    const directory = fs.mkdtempSync(join(tmpdir(), "pi-peek-render-"));
    temporaryDirectories.push(directory);
    const session = SessionManager.create(cwd, directory);
    session.appendMessage(assistant([toolCall()]));
    const file = session.getSessionFile()!;
    const { overlay } = createOverlay({}, file);
    const component = start(overlay);
    progress(overlay);
    const [timerId] = clock!.nativeTimers()[0];
    const socket = { connecting: false, destroyed: false, destroy() {} };
    overlay["socket"] = socket as any;
    const previousSize = overlay["lastFileSize"];
    const final = textResult("file final output", { details: { calls: calls(3) }, durationMs: 8600 });
    session.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "codemode", ...final, timestamp: 1001 });
    overlay["poll"]();
    expect(overlay["pendingTools"].get("call-1")!.component).toBe(component);
    expect(overlay["pendingTools"].get("call-1")!.executing).toBe(true);
    expect(toolRows(overlay)[0]).toBe(component);
    expect(clock!.timers.has(timerId)).toBe(true);
    expect(overlay["lastFileSize"]).toBeGreaterThan(previousSize);
    expect(overlay["lastFileSize"]).toBe(fs.statSync(file).size);
    expect(overlay["historyDirty"]).toBe(true);
    expect(overlay["sessionManager"]!.buildSessionContext().messages.some((message) => message.role === "toolResult")).toBe(true);
    if (state === "disconnected") overlay["socket"] = null;
    else if (state === "destroyed") socket.destroyed = true;
    else socket.connecting = true;
    // No further file write: the deferred projection must still be consumed.
    overlay["poll"]();
    expect(overlay["historyDirty"]).toBe(false);
    expect(clock!.clear).toHaveBeenCalledWith(timerId);
    expect(clock!.nativeTimers()).toHaveLength(0);
    expect(overlay["pendingTools"].size).toBe(0);
    expect(toolRows(overlay)[0]).not.toBe(component);
    const restored = toolRows(overlay)[0];
    expect(restored["expanded"]).toBe(false);
    expect(restored["executionStarted"]).toBe(false);
    expect(restored["argsComplete"]).toBe(false);
    const reference = referenceTool("codemode", codeArgs, nativeCodemodeRenderers);
    reference.updateResult(final);
    expectNativeLines(restored, reference);
  });
});
