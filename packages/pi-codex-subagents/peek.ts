import type { ContextUsage, Theme, ToolDefinition, ToolExecutionOptions, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  getMarkdownTheme,
  SessionManager,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Container,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as net from "node:net";
import {
  formatContextUsage,
  getSocketPath,
  isPeekActive,
  normalizeContextUsage,
  readInfoFile,
  RpcAssistantStreamState,
  type AgentInfo,
  type RpcAssistantStreamStatus,
} from "./core.js";

const TOOL_DEFINITION_FACTORIES = new Map<string, (cwd: string) => ToolDefinition<any, any, any>>([
  ["bash", (cwd) => defineTool(createBashToolDefinition(cwd))],
  ["edit", (cwd) => defineTool(createEditToolDefinition(cwd))],
  ["find", (cwd) => defineTool(createFindToolDefinition(cwd))],
  ["grep", (cwd) => defineTool(createGrepToolDefinition(cwd))],
  ["ls", (cwd) => defineTool(createLsToolDefinition(cwd))],
  ["powershell", (cwd) => defineTool(createPowerShellToolDefinition(cwd))],
  ["read", (cwd) => defineTool(createReadToolDefinition(cwd))],
  ["write", (cwd) => defineTool(createWriteToolDefinition(cwd))],
]);

const OSC133_PROMPT_MARKER_RE = /\x1b\]133;[ABC]\x07/g;

function stripPromptMarkers(lines: string[]): string[] {
  return lines.map((line) => line.replace(OSC133_PROMPT_MARKER_RE, ""));
}

export function formatAgentSpecLines(info: Pick<AgentInfo, "provider" | "modelId" | "thinking">): string[] {
  return [
    `Model: ${info.provider}/${info.modelId}`,
    `Thinking: ${info.thinking || "off"}`,
  ];
}

export class SubagentPeekOverlay {
  private readonly sessionFile: string;
  private readonly cwd: string;
  private readonly modelName: string;
  private sessionManager: SessionManager | null = null;
  private lastFileSize = 0;
  private contextUsage: ContextUsage | undefined;
  private lastInfoReadAt: number;
  private historyDirty = false; // A loaded snapshot may still await replay after live execution.
  private readonly chatContainer = new Container();
  private scrollOffset = 0;
  private followMode = true;
  private socket: net.Socket | null = null;
  private socketBuffer = "";
  private status: "thinking" | "streaming" | "calling" | "tool" | "done" = "done";
  private readonly assistantStream = new RpcAssistantStreamState();
  private streamingComponent: AssistantMessageComponent | null = null;
  private streamingMessage: AssistantMessage | null = null;
  // An unmatched historical call is pending, but is not evidence of live execution.
  private readonly pendingTools = new Map<string, { component: ToolExecutionComponent; executing: boolean }>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastConnectAttemptAt = 0;
  private cachedLines: string[] | null = null;
  private cachedWidth: number | null = null;
  private disposed = false;
  private readonly toolRenderUi: TUI;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly info: AgentInfo,
    private readonly done: (navigation?: "previous" | "next") => void,
    private readonly nativeCodemodeRenderers: ToolRenderers,
    private readonly toolExecutionOptions: ToolExecutionOptions = {},
  ) {
    // Define an own property: assigning through Pi’s TUI proxy prototype would mutate the shared TUI.
    this.toolRenderUi = Object.create(tui, {
      requestRender: {
        value: () => {
          if (this.disposed) return;
          this.invalidateCache();
          this.tui.requestRender();
        },
      },
    });
    this.sessionFile = info.sessionFile;
    this.cwd = info.cwd;
    this.modelName = info.modelId || info.model;
    this.contextUsage = normalizeContextUsage(info.contextUsage);
    this.lastInfoReadAt = Date.now();
    this.loadSession();
    this.rebuildChat();
    this.connectSocket();
    this.pollInterval = setInterval(() => this.poll(), 200);
  }

  private loadSession(): void {
    try {
      if (!fs.existsSync(this.sessionFile)) return;
      this.sessionManager = SessionManager.open(this.sessionFile);
      this.lastFileSize = fs.statSync(this.sessionFile).size;
    } catch {
      this.sessionManager = null;
    }
  }

  private finishToolComponents(): void {
    for (const child of this.chatContainer.children) {
      if (child instanceof ToolExecutionComponent) {
        // UI-only finalization releases native refresh resources on discarded rows.
        child.updateResult({ content: [], isError: false }, false);
      }
    }
  }

  private rebuildChat(): void {
    if (this.disposed) return;
    this.finishToolComponents();
    this.cleanupStreaming();
    this.invalidateCache();
    this.chatContainer.clear();
    this.historyDirty = false;
    if (!this.sessionManager) return;
    const context = this.sessionManager.buildSessionContext();
    for (const message of context.messages) {
      if (message.role === "user") {
        const text = this.getUserText(message);
        if (text) this.chatContainer.addChild(new UserMessageComponent(text, getMarkdownTheme()));
        continue;
      }
      if (message.role === "assistant") {
        this.chatContainer.addChild(new AssistantMessageComponent(message, true, getMarkdownTheme()));
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const component = this.createToolComponent(content.name, content.id, content.arguments);
          // Replay like the native transcript: args-complete is a live hook (edit previews read today’s files).
          this.chatContainer.addChild(component);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            component.updateResult({
              content: [{ type: "text", text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error") }],
              isError: true,
            });
          } else {
            this.pendingTools.set(content.id, { component, executing: false });
          }
        }
        continue;
      }
      if (message.role === "toolResult") {
        const component = this.pendingTools.get(message.toolCallId)?.component;
        if (component) {
          component.updateResult(message);
          this.pendingTools.delete(message.toolCallId);
        }
      }
    }
  }

  private createToolComponent(name: string, id: string, args: any): ToolExecutionComponent {
    const definition = (name === "codemode"
      ? this.nativeCodemodeRenderers
      : TOOL_DEFINITION_FACTORIES.get(name)?.(this.cwd)) ?? {};
    const component = new ToolExecutionComponent(
      name, id, args, this.toolExecutionOptions, definition, this.toolRenderUi, this.cwd,
    );
    component.setExpanded(false);
    return component;
  }

  private getUserText(message: any): string {
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content.filter((part: any) => part.type === "text" && part.text).map((part: any) => part.text).join("\n");
  }

  private connectSocket(): void {
    if (this.disposed) return;
    this.lastConnectAttemptAt = Date.now();
    try {
      const socket = net.connect(getSocketPath(this.info.id));
      this.socket = socket;
      this.socketBuffer = "";
      socket.on("error", () => {
        if (this.disposed || this.socket !== socket) return;
        socket.destroy();
      });
      socket.on("close", () => {
        if (this.disposed || this.socket !== socket) return;
        this.socket = null;
        this.refreshContextUsage();
        if (this.disposed) return;
        this.status = "done";
        this.cleanupStreaming();
        this.loadSession();
        this.rebuildChat();
        this.tui.requestRender();
      });
      socket.on("data", (data) => {
        if (this.disposed || this.socket !== socket) return;
        this.socketBuffer += data.toString();
        const lines = this.socketBuffer.split("\n");
        this.socketBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try { this.handleEvent(JSON.parse(line)); } catch {}
        }
      });
    } catch {
      this.socket = null;
    }
  }

  private handleEvent(event: any): void {
    if (this.disposed || event.type === "response") return;
    if (event.type === "sync") {
      this.loadSession();
      this.rebuildChat();
      this.status = event.status || "done";
      if (event.userMessage) {
        const text = this.getUserText(event.userMessage);
        if (text) this.chatContainer.addChild(new UserMessageComponent(text, getMarkdownTheme()));
      }
      if (event.partialMessage) {
        const streamStatus: RpcAssistantStreamStatus = event.status === "streaming" || event.status === "calling"
          ? event.status
          : "thinking";
        this.assistantStream.resume(event.partialMessage, streamStatus, event.toolArguments);
        this.streamingMessage = this.assistantStream.message;
        this.streamingComponent = new AssistantMessageComponent(undefined, true, getMarkdownTheme());
        this.chatContainer.addChild(this.streamingComponent);
        this.streamingComponent.updateContent(this.streamingMessage!);
        this.syncToolComponentsFromMessage();
      }
      for (const activeTool of event.activeTools ?? []) {
        let pending = this.pendingTools.get(activeTool.toolCallId);
        if (!pending) {
          const component = this.createToolComponent(activeTool.toolName, activeTool.toolCallId, activeTool.args);
          this.chatContainer.addChild(component);
          pending = { component, executing: false };
          this.pendingTools.set(activeTool.toolCallId, pending);
        }
        const { component } = pending;
        component.updateArgs(activeTool.args);
        if (activeTool.result) {
          component.updateResult({ ...activeTool.result, isError: activeTool.isError ?? false }, false);
          this.pendingTools.delete(activeTool.toolCallId);
        } else {
          pending.executing = true;
          component.setArgsComplete();
          component.markExecutionStarted();
          if (activeTool.partialResult) component.updateResult({ ...activeTool.partialResult, isError: false }, true);
        }
      }
    } else if (event.type === "message_start") {
      if (event.message?.role === "user") {
        const text = this.getUserText(event.message);
        if (text) this.chatContainer.addChild(new UserMessageComponent(text, getMarkdownTheme()));
      } else if (event.message?.role === "assistant") {
        this.cleanupStreaming();
        this.assistantStream.start(event.message);
        this.streamingMessage = this.assistantStream.message;
        this.streamingComponent = new AssistantMessageComponent(undefined, true, getMarkdownTheme());
        this.chatContainer.addChild(this.streamingComponent);
        this.streamingComponent.updateContent(this.streamingMessage!);
        this.status = "thinking";
      }
    } else if (event.type === "message_update") {
      this.ensureStreamingComponent();
      const delta = event.assistantMessageEvent;
      const previous = delta?.type === "toolcall_end"
        ? this.streamingMessage?.content[delta.contentIndex]
        : undefined;
      this.assistantStream.update(delta, event.message);
      if (previous?.type === "toolCall" && previous.id !== delta.toolCall?.id) {
        const component = this.pendingTools.get(previous.id)?.component;
        if (component) {
          component.updateResult({ content: [], isError: false }, false);
          this.chatContainer.removeChild(component);
        }
        this.pendingTools.delete(previous.id);
      }
      this.streamingMessage = this.assistantStream.message;
      if (this.streamingMessage) this.streamingComponent!.updateContent(this.streamingMessage);
      this.status = this.assistantStream.status;
      this.syncToolComponentsFromMessage();
    } else if (event.type === "message_end") {
      if (this.streamingComponent && event.message?.role === "assistant") {
        this.assistantStream.finish(event.message);
        this.streamingMessage = this.assistantStream.message;
        this.streamingComponent.updateContent(this.streamingMessage!);
        if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
          const errorMessage = event.message.errorMessage || "Error";
          for (const { component } of this.pendingTools.values()) {
            component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
          }
          this.pendingTools.clear();
        } else {
          for (const { component } of this.pendingTools.values()) component.setArgsComplete();
        }
        this.streamingComponent = null;
        this.streamingMessage = null;
        this.assistantStream.clear();
      }
    } else if (event.type === "tool_execution_start") {
      this.status = "tool";
      if (event.toolCallId) {
        let pending = this.pendingTools.get(event.toolCallId);
        if (!pending) {
          const component = this.createToolComponent(event.toolName, event.toolCallId, event.args);
          this.chatContainer.addChild(component);
          pending = { component, executing: true };
          this.pendingTools.set(event.toolCallId, pending);
        }
        pending.executing = true;
        const { component } = pending;
        component.updateArgs(event.args);
        component.setArgsComplete();
        component.markExecutionStarted();
      }
    } else if (event.type === "tool_execution_update" && event.toolCallId) {
      const pending = this.pendingTools.get(event.toolCallId);
      if (pending && event.partialResult) {
        pending.executing = true;
        const { component } = pending;
        component.setArgsComplete();
        component.markExecutionStarted();
        component.updateResult({ ...event.partialResult, isError: false }, true);
      }
    } else if (event.type === "tool_execution_end" && event.toolCallId) {
      const component = this.pendingTools.get(event.toolCallId)?.component;
      if (component) {
        component.updateResult({
          ...event.result,
          isError: event.isError ?? false,
          durationMs: event.durationMs ?? event.result?.durationMs,
        }, false);
        this.pendingTools.delete(event.toolCallId);
      }
    } else if (event.type === "agent_settled") {
      this.cleanupStreaming();
      this.loadSession();
      this.rebuildChat();
      this.status = "done";
    }
    this.invalidateCache();
    if (this.followMode) this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.tui.requestRender();
  }

  private syncToolComponentsFromMessage(): void {
    if (!this.streamingMessage) return;
    for (const content of this.streamingMessage.content) {
      if (content.type !== "toolCall") continue;
      const existing = this.pendingTools.get(content.id);
      if (existing) {
        existing.component.updateArgs(content.arguments);
      } else {
        const component = this.createToolComponent(content.name, content.id, content.arguments);
        this.chatContainer.addChild(component);
        this.pendingTools.set(content.id, { component, executing: false });
      }
    }
  }

  private ensureStreamingComponent(): void {
    if (this.streamingComponent) return;
    this.streamingMessage = {
      role: "assistant",
      content: [],
      api: "" as any,
      provider: "" as any,
      model: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop" as any,
      timestamp: Date.now(),
    };
    this.assistantStream.start(this.streamingMessage);
    this.streamingComponent = new AssistantMessageComponent(undefined, true, getMarkdownTheme());
    this.chatContainer.addChild(this.streamingComponent);
    this.streamingComponent.updateContent(this.streamingMessage);
  }

  private cleanupStreaming(): void {
    if (this.streamingComponent) this.chatContainer.removeChild(this.streamingComponent);
    this.assistantStream.clear();
    this.streamingComponent = null;
    this.streamingMessage = null;
    this.pendingTools.clear();
  }

  private refreshContextUsage(): boolean {
    if (this.disposed) return false;
    this.lastInfoReadAt = Date.now();
    const info = readInfoFile(this.info.infoFile);
    if (this.disposed || !info) return false;
    const next = normalizeContextUsage(info.contextUsage);
    if (next?.contextWindow === this.contextUsage?.contextWindow &&
      next?.tokens === this.contextUsage?.tokens && next?.percent === this.contextUsage?.percent) return false;
    this.contextUsage = next;
    return true;
  }

  private poll(): void {
    if (this.disposed) return;
    if (Date.now() - this.lastInfoReadAt >= 1000 && this.refreshContextUsage()) this.tui.requestRender();
    if (this.disposed) return;
    if (!this.socket && isPeekActive(this.info.id) && Date.now() - this.lastConnectAttemptAt >= 2000) this.connectSocket();
    try {
      const size = fs.statSync(this.sessionFile).size;
      if (size !== this.lastFileSize) {
        this.loadSession();
        this.historyDirty = true;
      }
      if (!this.historyDirty) return;
      const hasLiveUpdates = this.socket && !this.socket.connecting && !this.socket.destroyed &&
        (this.streamingComponent || [...this.pendingTools.values()].some((tool) => tool.executing));
      if (hasLiveUpdates) return;
      this.rebuildChat();
      this.invalidateCache();
      if (this.followMode) this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
    } catch {}
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
      this.dispose();
      this.done();
    } else if (matchesKey(data, "left")) {
      this.dispose();
      this.done("previous");
    } else if (matchesKey(data, "right")) {
      this.dispose();
      this.done("next");
    } else if (matchesKey(data, "up") || data === "k") {
      this.followMode = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.scrollOffset++;
      this.tui.requestRender();
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.followMode = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 15);
      this.tui.requestRender();
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
      this.scrollOffset += 15;
      this.tui.requestRender();
    } else if (data === "g") {
      this.followMode = false;
      this.scrollOffset = 0;
      this.tui.requestRender();
    } else if (data === "G" || matchesKey(data, "shift+g")) {
      this.followMode = true;
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
    }
  }

  private invalidateCache(): void {
    this.cachedLines = null;
    this.cachedWidth = null;
  }

  invalidate(): void {
    if (this.disposed) return;
    this.chatContainer.invalidate();
    this.invalidateCache();
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    if (width < 3) return [];
    const innerWidth = width - 2;
    const title = ` ${this.info.taskName} `;
    const modelTag = this.modelName ? `[${truncateToWidth(this.modelName, 18)}] ` : "";
    const statusIcon = { thinking: "◐", streaming: "●", calling: "◒", tool: "◑", done: "✓" }[this.status];
    const statusColor = { thinking: "warning", streaming: "success", calling: "accent", tool: "accent", done: "success" }[this.status];
    const statusText = truncateToWidth(` ${statusIcon} ${this.status} `, innerWidth);
    const heading = truncateToWidth(
      this.theme.fg("accent", title) + this.theme.fg("dim", modelTag),
      Math.max(0, innerWidth - visibleWidth(statusText)),
    );
    const headerWidth = visibleWidth(heading) + visibleWidth(statusText);
    const lines = [
      this.theme.fg("border", "╭") + heading +
      this.theme.fg("border", "─".repeat(Math.max(0, innerWidth - headerWidth))) +
      this.theme.fg(statusColor as any, statusText) +
      this.theme.fg("border", "╮"),
    ];

    let contentLines: string[];
    if (this.cachedLines && this.cachedWidth === innerWidth) contentLines = this.cachedLines;
    else {
      const specLines = formatAgentSpecLines(this.info).map((line) => this.theme.fg("dim", line));
      contentLines = [...specLines, "", ...stripPromptMarkers(this.chatContainer.render(innerWidth))];
      this.cachedLines = contentLines;
      this.cachedWidth = innerWidth;
    }

    const maxHeight = Math.min(60, Math.max(8, this.tui.terminal.rows - 4));
    const maxVisible = maxHeight - 4;
    const maxScroll = Math.max(0, contentLines.length - maxVisible);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + maxVisible);
    for (const line of visible) {
      const padded = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      lines.push(this.theme.fg("border", "│") + truncateToWidth(padded, innerWidth) + this.theme.fg("border", "│"));
    }
    for (let index = visible.length; index < maxVisible; index++) {
      lines.push(this.theme.fg("border", "│") + " ".repeat(innerWidth) + this.theme.fg("border", "│"));
    }
    const scrollInfo = contentLines.length > maxVisible
      ? `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + maxVisible, contentLines.length)}/${contentLines.length}`
      : `${contentLines.length}L`;
    const followIcon = this.followMode ? this.theme.fg("success", "●") : this.theme.fg("dim", "○");
    lines.push(this.theme.fg("border", "├" + "─".repeat(innerWidth) + "┤"));
    const footer = truncateToWidth(` ${scrollInfo} ${followIcon} │ ${formatContextUsage(this.contextUsage)} │ ←/→ agent │ j/k scroll │ g/G top/end │ q close `, innerWidth);
    lines.push(this.theme.fg("border", "│") + this.theme.fg("dim", footer) + " ".repeat(Math.max(0, innerWidth - visibleWidth(footer))) + this.theme.fg("border", "│"));
    lines.push(this.theme.fg("border", "╰" + "─".repeat(innerWidth) + "╯"));
    return lines;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = null;
    this.socket?.destroy();
    this.socket = null;
    this.finishToolComponents();
    this.cleanupStreaming();
    this.chatContainer.clear();
    this.invalidateCache();
  }
}
