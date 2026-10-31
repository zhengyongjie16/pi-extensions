#!/usr/bin/env node

import * as fs from "node:fs";
import * as readline from "node:readline";

const sessionIndex = process.argv.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;
const requestedModel = {
  provider: process.argv[process.argv.indexOf("--provider") + 1],
  id: process.argv[process.argv.indexOf("--model") + 1],
};
// Fixed fixture routes, never populated from arbitrary CLI arguments.
const models = [
  { provider: "test", id: "fake" },
  { provider: "test", id: "template-model" },
  { provider: "template-provider", id: "template-model" },
  { provider: "openai", id: "gpt-5" },
  { provider: "fireworks", id: "accounts/fireworks/models/glm-5p2" },
];
const modelResponses = JSON.parse(process.env.PI_SUBAGENT_TEST_MODEL_RESPONSES || "{}");

function record(value) {
  if (sessionFile) fs.appendFileSync(sessionFile, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

record({ type: "started", args: process.argv.slice(2) });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type !== "prompt") record({ type: command.type });
  if (modelResponses.exitOn === command.type) process.exit(23);
  if (modelResponses.holdOn === command.type) return;
  if (command.type === "get_state" || command.type === "get_available_models") {
    const key = command.type === "get_state" ? "state" : "availableModels";
    const data = Object.hasOwn(modelResponses, key) ? modelResponses[key] : key === "state" ? { model: requestedModel } : { models };
    send({ type: "response", id: command.id, success: true, data });
    return;
  }
  if (command.type === "prompt") {
    record({ type: "prompt", message: command.message });
    if (String(command.message).startsWith("reject")) {
      send({ type: "response", id: command.id, success: false, error: "fake prompt rejection" });
      return;
    }
    send({ type: "response", id: command.id, success: true, data: {} });
    send({ type: "agent_start" });
    if (String(command.message).startsWith("hold")) return;
    if (String(command.message).startsWith("stream")) {
      send({
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
          api: "test",
          provider: "test",
          model: "fake",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
          stopReason: "pending",
          timestamp: Date.now(),
        },
      });
      send({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } });
      send({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"' } });
      setInterval(() => {
        send({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: " \\n" } });
      }, 5);
      return;
    }
    if (String(command.message).startsWith("tool hold")) {
      const assistant = {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep" } }],
        api: "test",
        provider: "test",
        model: "fake",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
      send({ type: "message_start", message: { ...assistant, content: [] } });
      send({ type: "message_end", message: assistant });
      send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "sleep" } });
      return;
    }
    if (String(command.message).startsWith("crash")) {
      setTimeout(() => process.exit(23), 20);
      return;
    }
    const message = String(command.message);
    setTimeout(() => {
      const failing = message.startsWith("fail");
      const response = message.startsWith("large") ? "x".repeat(60 * 1024) : `response:${message}`;
      send({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: response }],
          stopReason: failing ? "error" : "stop",
          ...(failing ? { errorMessage: "fake failure" } : {}),
        },
      });
      send({ type: "agent_settled" });
    }, message.startsWith("slow") ? 200 : 50);
    return;
  }
  if (command.type === "steer" || command.type === "abort") {
    send({ type: "response", id: command.id, success: true, data: {} });
  }
});
