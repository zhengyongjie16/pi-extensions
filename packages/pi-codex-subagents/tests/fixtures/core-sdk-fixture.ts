import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// An explicitly selected real extension/provider. Controls live outside AgentManager:
// production has no backend/Session injection or fixture switch.
export interface CoreFixtureInstance {
  inputs: InputEvent[];
  requests: Array<{ text: string; context: any; message: AssistantMessage }>;
  events: string[];
  ctx?: ExtensionContext;
  shutdowns: number;
  activeStreams: number;
  activeTools: number;
}
export interface CoreFixtureOptions {
  routes?: Array<[string, string, number?]>;
  startupGate?: Promise<void>;
  shutdownGate?: Promise<void>;
  responseGate?: Promise<void>;
  ignoreAbort?: boolean;
  shutdownAtStart?: boolean;
  onStart?: (pi: ExtensionAPI, ctx: ExtensionContext) => void | Promise<void>;
  onShutdown?: () => void | Promise<void>;
  onSettled?: (aborted: boolean, pi: ExtensionAPI) => void | Promise<void>;
  input?: (event: InputEvent, ctx: ExtensionContext, instance: CoreFixtureInstance) => Promise<InputEventResult | void> | InputEventResult | void;
  tokens?: number | ((text: string) => number);
  response?: (text: string) => string;
}
export interface CoreFixtureState extends CoreFixtureOptions {
  instances: CoreFixtureInstance[];
}
const key = Symbol.for("pi-codex-subagents.core-test-fixture");
const shared = globalThis as typeof globalThis & { [key]: CoreFixtureState };
export function configureCoreFixture(options: CoreFixtureOptions = {}): CoreFixtureState {
  return shared[key] = { ...options, instances: [] };
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const routes: Array<[string, string]> = [
  ["test", "fake"], ["test", "template-model"], ["template-provider", "template-model"],
  ["openai", "gpt-5"], ["fireworks", "accounts/fireworks/models/glm-5p2"],
];
function textOf(message: any): string {
  return typeof message?.content === "string" ? message.content
    : (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}
async function pause(promise: Promise<void>, signal?: AbortSignal, ignoreAbort = false): Promise<void> {
  if (ignoreAbort || !signal) return promise;
  if (signal.aborted) throw new Error("aborted");
  let abort!: () => void;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await pause(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}
export default function coreSdkFixture(pi: ExtensionAPI) {
  const state = shared[key] ?? configureCoreFixture();
  const instance: CoreFixtureInstance = { inputs: [], requests: [], events: ["factory"], shutdowns: 0, activeStreams: 0, activeTools: 0 };
  state.instances.push(instance);
  for (const provider of new Set((state.routes ?? routes).map(([provider]) => provider))) {
    pi.registerProvider(provider, {
      api: "core-offline-fixture", apiKey: "offline-fixture", baseUrl: "http://127.0.0.1:9",
      models: (state.routes ?? routes).filter(([name]) => name === provider).map(([, id, window]) => ({
        id, name: id, api: "core-offline-fixture", reasoning: true, input: ["text"],
        contextWindow: window ?? 500000, maxTokens: 100000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
      streamSimple(model, context, options) {
        const stream = createAssistantMessageEventStream();
        const text = textOf(context.messages.findLast((message) => message.role === "user"));
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [], timestamp: Date.now(), stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        instance.requests.push({ text, context: structuredClone(context), message });
        instance.activeStreams++;
        void (async () => {
          let interval: ReturnType<typeof setInterval> | undefined;
          try {
            stream.push({ type: "start", partial: message });
            if (text.startsWith("stream")) {
              message.content.push({ type: "toolCall", id: "stream-call", name: "fixture_hold", arguments: {} });
              stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"', partial: message });
              interval = setInterval(() => stream.push({ type: "toolcall_delta", contentIndex: 0, delta: " ", partial: message }), 5);
              await pause(state.responseGate ?? new Promise(() => {}), options?.signal, state.ignoreAbort);
            } else if (text.startsWith("hold")) {
              await pause(state.responseGate ?? new Promise(() => {}), options?.signal, state.ignoreAbort);
            } else if (text.startsWith("tool hold") && context.messages.at(-1)?.role !== "toolResult") {
              const toolCall = { type: "toolCall" as const, id: "fixture-call", name: "fixture_hold", arguments: {} };
              message.content.push(toolCall);
              message.stopReason = "toolUse";
              stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
              stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
              stream.push({ type: "done", reason: "toolUse", message });
              return;
            } else {
              await delay(text.startsWith("slow") ? 200 : 35, options?.signal);
            }
            const response = state.response?.(text) ?? (text.startsWith("large") ? "x".repeat(60 * 1024) : "response:" + text);
            const index = message.content.length;
            message.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: index, partial: message });
            (message.content[index] as any).text = response;
            stream.push({ type: "text_delta", contentIndex: index, delta: response, partial: message });
            stream.push({ type: "text_end", contentIndex: index, content: response, partial: message });
            const tokens = typeof state.tokens === "function" ? state.tokens(text) : state.tokens ?? 60000;
            message.usage.input = tokens;
            message.usage.totalTokens = tokens;
            if (text.startsWith("fail") || text.startsWith("crash")) {
              message.stopReason = "error";
              message.errorMessage = "fixture failure";
              stream.push({ type: "error", reason: "error", error: message });
            } else if (text.startsWith("aborted")) {
              message.stopReason = "aborted";
              stream.push({ type: "error", reason: "aborted", error: message });
            } else {
              stream.push({ type: "done", reason: "stop", message });
            }
          } catch (error) {
            message.stopReason = options?.signal?.aborted ? "aborted" : "error";
            message.errorMessage = error instanceof Error ? error.message : String(error);
            stream.push({ type: "error", reason: message.stopReason, error: message });
          } finally {
            clearInterval(interval);
            instance.activeStreams--;
            stream.end();
          }
        })();
        return stream;
      },
    });
  }
  pi.registerTool({
    name: "fixture_hold", label: "Fixture hold", description: "Offline cooperative tool.", parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      instance.activeTools++;
      try {
        await pause(new Promise(() => {}), signal);
        return { content: [{ type: "text", text: "released" }] };
      } finally { instance.activeTools--; }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    instance.ctx = ctx;
    instance.events.push("session_start");
    if (state.shutdownAtStart) ctx.shutdown();
    await state.startupGate;
    await state.onStart?.(pi, ctx);
    instance.events.push("initialized");
  });
  pi.on("input", async (event, ctx) => {
    instance.inputs.push({ ...event });
    const result = await state.input?.(event, ctx, instance);
    if (result) return result;
    if (event.text.startsWith("handled work")) {
      pi.sendUserMessage("hold handled-owned-work");
      // Let the native submitted prompt reach streaming before returning handled.
      while (!instance.activeStreams) await delay(1);
      return { action: "handled" };
    }
    if (event.text.startsWith("handled")) return { action: "handled" };
    if (event.text.startsWith("shutdown input")) {
      ctx.shutdown();
      return { action: "handled" };
    }
    return { action: "continue" };
  });
  pi.on("agent_settled", async (event) => {
    instance.events.push(event.aborted ? "settled:aborted" : "settled:success");
    await state.onSettled?.(event.aborted, pi);
  });
  pi.on("session_shutdown", async () => {
    instance.shutdowns++;
    instance.events.push("session_shutdown");
    await state.shutdownGate;
    await state.onShutdown?.();
  });
}
