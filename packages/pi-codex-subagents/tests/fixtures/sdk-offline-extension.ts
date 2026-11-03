/** Real SDK fixture: an in-memory provider and explicitly loaded, headless extension. */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface OfflineFixtureConfig {
  provider?: string;
  modelId?: string;
  prefix?: string;
  filtered?: boolean;
  filterAtStart?: boolean;
  changeModelAtStart?: boolean;
  badRegistration?: boolean;
  badRegistrationAtStart?: boolean;
  factoryGate?: boolean;
  startupGate?: boolean;
  responseGate?: boolean;
  shutdownGate?: boolean;
  shutdownAtStart?: boolean;
  shutdownError?: boolean;
  stopReason?: "error" | "aborted";
  resources?: { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] };
}

// Intentionally module-scoped: a fresh Session does NOT promise module reevaluation.
const MODULE_VERSION = "fixture-v1";
let factoryInvocations = 0;

export default async function (pi: ExtensionAPI) {
  const directory = dirname(fileURLToPath(import.meta.url));
  const config: OfflineFixtureConfig = JSON.parse(readFileSync(join(directory, "sdk-fixture.json"), "utf8"));
  const record = (type: string, data: Record<string, unknown> = {}) =>
    appendFileSync(join(directory, "sdk-events.jsonl"), JSON.stringify({ type, ...data }) + "\n");
  const waitForRelease = async (name: string, signal?: AbortSignal) => {
    while (!existsSync(join(directory, "release-" + name))) await delay(5, undefined, { signal });
  };
  const invocation = ++factoryInvocations;
  record("factory", { invocation, moduleVersion: MODULE_VERSION });
  if (config.factoryGate) await waitForRelease("factory");

  const providerId = config.provider ?? "sdk-offline";
  const modelId = config.modelId ?? "exact/model";
  const models: Model<string>[] = [modelId, "other-model"].map((id) => ({
    id, provider: providerId, name: id, api: "sdk-offline-api", baseUrl: "http://offline.invalid",
    reasoning: false, input: ["text"], contextWindow: 500_000, maxTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  let requestCount = 0;
  const streamSimple: Provider["streamSimple"] = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const request = ++requestCount;
    const userTexts = context.messages.filter((m) => m.role === "user").map((m) =>
      typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join(""));
    record("request", { request, userTexts, systemPrompt: getCurrentSystemPrompt(context.messages) });
    void (async () => {
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: "pending",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      try {
        stream.push({ type: "start", partial: message });
        if (config.responseGate && request === 1) await waitForRelease("response", options?.signal);
        options?.signal?.throwIfAborted();
        if (config.stopReason) throw new Error("fixture " + config.stopReason);
        const text = (config.prefix ?? "offline") + ": " + userTexts.at(-1);
        message.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        message.content[0] = { type: "text", text };
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        message.usage.input = 50_000;
        message.usage.totalTokens = 50_000;
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message });
      } catch (error) {
        message.stopReason = options?.signal?.aborted || config.stopReason === "aborted" ? "aborted" : "error";
        message.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } finally {
        record("response", { request, stopReason: message.stopReason });
        stream.end();
      }
    })();
    return stream;
  };
  const provider: Provider = {
    id: providerId, name: "Offline SDK contract provider", baseUrl: "http://offline.invalid",
    auth: { apiKey: { name: "Offline", async resolve() { return { auth: { apiKey: "offline-only" } }; } } },
    getModels: () => models,
    ...(config.filtered ? { filterModels: () => [] } : {}),
    stream: streamSimple,
    streamSimple,
  };
  pi.registerProvider(provider);
  if (config.badRegistration) {
    // Invalid overlay must not be hidden by the same-name provider's valid catalog.
    pi.registerProvider(providerId, { streamSimple });
  }
  pi.registerTool({
    name: "fixture_tool", label: "Offline fixture", description: "Never calls a network",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "fixture tool" }], details: {} }; },
  });
  pi.on("session_start", async (_event, ctx) => {
    record("session_start", { mode: ctx.mode, hasUI: ctx.hasUI, trusted: ctx.isProjectTrusted(), invocation });
    if (config.shutdownAtStart) ctx.shutdown();
    if (config.startupGate) await waitForRelease("startup");
    if (config.badRegistrationAtStart) pi.registerProvider(providerId, { streamSimple });
    if (config.filterAtStart) pi.registerProvider({ ...provider, filterModels: () => [] });
    if (config.changeModelAtStart) {
      // pi.setModel uses the auth snapshot, unlike provider-specific getAvailable().
      // Refresh through the public registry API before requesting a model change.
      // ModelRegistry.getAvailable() is a synchronous snapshot, not ModelRuntime.getAvailable().
      await ctx.modelRegistry.refresh({ allowNetwork: false });
      const changed = await pi.setModel(models[1]!);
      record("model_changed", { changed, selectedModel: ctx.model?.id });
    }
  });
  pi.on("resources_discover", () => config.resources);
  pi.on("input", async (event, ctx) => {
    record("input", { text: event.text, source: event.source, streamingBehavior: event.streamingBehavior });
    if (event.text === "fixture:input-gate" || event.text === "fixture:steer-gate") await waitForRelease("input");
    if (event.text === "fixture:shutdown") { ctx.shutdown(); return { action: "handled" }; }
    if (event.text === "fixture:handled") return { action: "handled" };
    if (event.text === "fixture:handled-run") {
      pi.sendUserMessage("work started by handled input");
      while (ctx.isIdle()) await delay(1);
      return { action: "handled" };
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType === "user" && event.prompt === "fixture:abort-before-run") ctx.abort();
  });
  pi.on("session_shutdown", async () => {
    record("session_shutdown");
    if (config.shutdownGate) await waitForRelease("shutdown");
    if (config.shutdownError) throw new Error("fixture shutdown failure");
    record("shutdown_finished");
  });
}
