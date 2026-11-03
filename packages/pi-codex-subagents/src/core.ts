import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG_DIR_NAME, getAgentDir, type AgentSession, type AgentSessionEvent, type ContextUsage } from "@earendil-works/pi-coding-agent";
import { createChildSession, promptChildSession, shutdownChildSession } from "./runtime.js";
import { parseStreamingJson, type AssistantMessage } from "@earendil-works/pi-ai";

export const PACKAGE_BASENAME = "pi-codex-subagents";
export const SUBAGENT_DIR = path.join(getAgentDir(), PACKAGE_BASENAME);
const CONFIG_PATH = path.join(SUBAGENT_DIR, "config.json");
const SYSTEM_PROMPT_PATH = path.join(SUBAGENT_DIR, "SYSTEM.md");
const AGENTS_DIR = path.join(SUBAGENT_DIR, "agents");
const TEMP_ROOT = path.join(process.env.PI_SUBAGENT_TEMP_DIR || os.tmpdir(), PACKAGE_BASENAME, os.userInfo().username);
const LEGACY_RUNS_DIR = path.join(TEMP_ROOT, "runs");
const SOCKET_DIR = path.join(TEMP_ROOT, "sockets");

export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const CLEANUP_WAIT_TIMEOUT_MS = 2_000;

async function boundedWait<T>(promise: Promise<T>, timeoutMs: number, message: string | Error, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(typeof message === "string" ? new Error(message) : message), timeoutMs);
        if (signal) {
          onAbort = () => reject(abortError(signal));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_MODEL_RESPONSE_TIMEOUT_MS = 10 * 60_000;
const ACTIVITY_PERSIST_INTERVAL_MS = 5_000;
export const DEFAULT_THINKING = "high";
export const DEFAULT_TOOLS = "read,bash,grep,find,ls";
const DEFAULT_SUBAGENT_SYSTEM_PROMPT = "You are a subagent working for a main agent. Work only on the assigned task and follow its scope precisely.";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const FINAL_STATUSES = new Set<AgentRuntimeStatus>(["completed", "failed", "interrupted"]);

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type AgentRuntimeStatus = "starting" | "running" | "completed" | "failed" | "interrupted";

export interface SubagentConfig {
  shortcut?: string;
  storageDir?: string;
  retentionDays?: number;
  models?: string[];
  modelsFromEnabledModels?: boolean;
  modelResponseTimeoutMs?: number;
  defaults?: {
    skills?: string[];
    extensions?: string[];
  };
}

export interface AgentDefinition {
  name: string;
  description?: string;
  hint?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string;
  skills?: string[];
  extensions?: string[];
  prompt?: string;
}

export interface AgentInfo {
  id: string;
  taskName: string;
  canonicalName: string;
  parentSessionId: string;
  parentSessionFile?: string;
  agentType?: string;
  provider: string;
  modelId: string;
  model: string;
  thinking?: ThinkingLevel;
  tools?: string;
  skills?: string[];
  skillPaths?: string[];
  extensions?: string[];
  extensionPaths?: string[];
  cwd: string;
  sessionFile: string;
  infoFile: string;
  logFile: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  lastActivity?: number;
  messageCount: number;
  status: AgentRuntimeStatus;
  lastTaskMessage?: string;
  finalResponse?: string;
  error?: string;
  contextUsage?: ContextUsage;
}

export interface AgentListEntry {
  agent_name: string;
  agent_status: AgentRuntimeStatus;
  last_task_message: string | null;
  parent_session_id?: string;
}

export interface AgentResponseEntry {
  agent_name: string;
  status: AgentRuntimeStatus;
  finalResponse?: string;
  error?: string;
  last_task_message: string | null;
}

export interface SpawnAgentParams {
  task_name: string;
  message: string;
  agent_type?: string;
  skills?: string[];
  loadedSkillPaths?: Record<string, string>;
  cwd: string;
  parentSessionId: string;
  parentSessionFile?: string;
  inheritedProvider: string;
  inheritedModelId: string;
  inheritedThinking?: ThinkingLevel;
  inheritedTools?: string;
  model?: { provider: string; modelId: string };
  thinking?: ThinkingLevel;
}

interface LiveAgent {
  info: AgentInfo;
  session?: AgentSession;
  initialization?: Promise<AgentSession>;
  promptFinished?: Promise<void>;
  pendingSteers: Set<Promise<unknown>>;
  unsubscribe?: () => void;
  broadcaster: EventBroadcaster;
  logger: SessionLogger;
  cancellation: AbortController;
  closing: boolean;
  finalizedRun: boolean;
  awaitingPrompt: boolean;
  accepted: boolean;
  /** Hidden while input is tentative; keep its identity until acceptance or rollback. */
  suspendedCompletion?: AgentCompletionEvent;
  termination?: Promise<void>;
  candidateResponse: string;
  candidateError?: string;
  settledAborted: boolean;
  eventError?: Error;
  modelResponseTimer?: ReturnType<typeof setTimeout>;
  lastActivityPersistedAt: number;
}

export interface AgentCompletionEvent {
  id: string;
  parentSessionId: string;
  agentName: string;
  status: AgentRuntimeStatus;
  finalResponse?: string;
  error?: string;
  createdAt: number;
}

export interface AgentActivityEvent {
  parentSessionId: string;
  agentName: string;
  active: boolean;
}

export interface AgentManagerOptions {
  onActivityChange?: (event: AgentActivityEvent) => void;
  onUnclaimedCompletion?: (event: AgentCompletionEvent) => void;
  modelResponseTimeoutMs?: number;
  projectTrusted?: (cwd: string) => boolean | undefined;
  onError?: (error: Error) => void;
}

interface Waiter {
  parentSessionId: string;
  targets?: Set<string>;
  resolve: (event: AgentCompletionEvent) => void;
}

export function formatAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const errno = error && typeof error === "object" ? (error as { errno?: unknown }).errno : undefined;
  const edquot = os.constants.errno.EDQUOT;
  const quotaExceeded = (typeof edquot === "number" && (errno === edquot || errno === -edquot || message.includes(`system error -${edquot}`)))
    || (error && typeof error === "object" && (error as { code?: unknown }).code === "EDQUOT")
    || /\bEDQUOT\b/.test(message);
  return quotaExceeded && !/disk quota exceeded/i.test(message)
    ? `${message}\nCause: Disk quota exceeded (EDQUOT).`
    : message;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Wait canceled.");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function expandHome(value: string): string {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function stringList(value: unknown): string[] | undefined {
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  const normalized = entries.map((entry) => entry.trim()).filter(Boolean);
  return normalized.length ? normalized : undefined;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function normalizeConfig(value: unknown): SubagentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const defaultsRaw = raw.defaults && typeof raw.defaults === "object" && !Array.isArray(raw.defaults)
    ? raw.defaults as Record<string, unknown>
    : undefined;
  const defaults = defaultsRaw ? {
    ...(stringList(defaultsRaw.skills) ? { skills: stringList(defaultsRaw.skills) } : {}),
    ...(stringList(defaultsRaw.extensions) ? { extensions: stringList(defaultsRaw.extensions) } : {}),
  } : undefined;
  const retentionDays = typeof raw.retentionDays === "number" && Number.isFinite(raw.retentionDays) && raw.retentionDays >= 0
    ? raw.retentionDays
    : undefined;
  const modelResponseTimeoutMs = typeof raw.modelResponseTimeoutMs === "number"
    && Number.isFinite(raw.modelResponseTimeoutMs)
    && raw.modelResponseTimeoutMs >= 0
    ? raw.modelResponseTimeoutMs
    : undefined;
  return {
    ...(typeof raw.shortcut === "string" && raw.shortcut.trim() ? { shortcut: raw.shortcut.trim() } : {}),
    ...(typeof raw.storageDir === "string" && raw.storageDir.trim() ? { storageDir: raw.storageDir.trim() } : {}),
    ...(retentionDays !== undefined ? { retentionDays } : {}),
    ...(stringList(raw.models) ? { models: stringList(raw.models) } : {}),
    ...(raw.modelsFromEnabledModels === true ? { modelsFromEnabledModels: true } : {}),
    ...(modelResponseTimeoutMs !== undefined ? { modelResponseTimeoutMs } : {}),
    ...(defaults && Object.keys(defaults).length ? { defaults } : {}),
  };
}

export function loadSubagentConfig(): SubagentConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch {}
  return {};
}

export function getRunsDir(): string {
  const configured = loadSubagentConfig().storageDir;
  if (configured) {
    const expanded = expandHome(configured);
    return path.isAbsolute(expanded) ? expanded : path.resolve(SUBAGENT_DIR, expanded);
  }
  return path.join(SUBAGENT_DIR, "runs");
}

function ensurePrivateDir(directory: string, enforceMode = false): void {
  const existed = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && (enforceMode || !existed)) fs.chmodSync(directory, 0o700);
}

function ensureSystemPromptFile(): void {
  if (fs.existsSync(SYSTEM_PROMPT_PATH)) return;
  try {
    fs.writeFileSync(SYSTEM_PROMPT_PATH, DEFAULT_SUBAGENT_SYSTEM_PROMPT, { flag: "wx", mode: 0o600 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function readSystemPrompt(): string {
  ensureSystemPromptFile();
  const prompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  if (!prompt.trim()) throw new Error(`Subagent system prompt is empty: ${SYSTEM_PROMPT_PATH}`);
  return prompt;
}

function ensureBaseDirs(): void {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  ensureSystemPromptFile();
  ensurePrivateDir(getRunsDir(), !loadSubagentConfig().storageDir);
  ensurePrivateDir(SOCKET_DIR, true);
}

const SCOPE_DIR_PATTERN = /^[0-9a-f]{24}$/;
const AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTPUT_FILE_PATTERN = /^\d+-[0-9a-f-]{36}\.txt$/i;
const TASK_LOCK_PATTERN = /^\.task-[0-9a-f]{24}\.lock$/;

function isAgentArtifact(name: string, agentId: string): boolean {
  return name === `${agentId}.jsonl`
    || name === `${agentId}.info.json`
    || name === `${agentId}.log`
    || new RegExp(`^${agentId}\\.info\\.json\\.\\d+\\.tmp$`).test(name);
}

function pruneScope(directory: string, cutoff: number): void {
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".info.json")) continue;
    const agentId = entry.name.slice(0, -".info.json".length);
    if (!AGENT_ID_PATTERN.test(agentId)) continue;
    const info = readInfoFile(path.join(directory, entry.name));
    const agentEntries = entries.filter((candidate) => candidate.isFile() && isAgentArtifact(candidate.name, agentId));
    let latest = Math.max(info?.lastActivity ?? 0, info?.updatedAt ?? 0, info?.createdAt ?? 0);
    for (const candidate of agentEntries) {
      try { latest = Math.max(latest, fs.statSync(path.join(directory, candidate.name)).mtimeMs); } catch {}
    }
    if (isRunActive(agentId) || latest >= cutoff) continue;
    let failed = false;
    for (const candidate of agentEntries.filter((candidate) => candidate.name !== entry.name)) {
      try { fs.rmSync(path.join(directory, candidate.name), { force: true }); } catch { failed = true; }
    }
    if (failed) continue;
    try { fs.rmSync(path.join(directory, entry.name), { force: true }); } catch {}
  }

  for (const entry of entries) {
    if (!entry.isFile() || !TASK_LOCK_PATTERN.test(entry.name)) continue;
    const lockFile = path.join(directory, entry.name);
    try {
      if (fs.statSync(lockFile).mtimeMs >= cutoff) continue;
      const owner = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: number };
      if (typeof owner.pid === "number" && processAlive(owner.pid)) continue;
    } catch {}
    try { fs.rmSync(lockFile, { force: true }); } catch {}
  }

  try { fs.rmdirSync(directory); } catch {}
}

function pruneRunsRoot(root: string, cutoff: number): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.name === "_outputs" && entry.isDirectory()) {
      let outputs: fs.Dirent[];
      try { outputs = fs.readdirSync(target, { withFileTypes: true }); } catch { continue; }
      for (const output of outputs) {
        if (!output.isFile() || !OUTPUT_FILE_PATTERN.test(output.name)) continue;
        const outputPath = path.join(target, output.name);
        try {
          if (fs.statSync(outputPath).mtimeMs < cutoff) fs.rmSync(outputPath, { force: true });
        } catch {}
      }
      continue;
    }
    if (!entry.isDirectory() || !SCOPE_DIR_PATTERN.test(entry.name)) continue;
    try { pruneScope(target, cutoff); } catch {}
  }
}

function pruneExpiredRuns(): void {
  const retentionDays = loadSubagentConfig().retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (retentionDays === 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const root of runsRoots()) pruneRunsRoot(root, cutoff);
}

export function parentScopeKey(parentSessionId: string): string {
  return createHash("sha256").update(parentSessionId).digest("hex").slice(0, 24);
}

export function taskStorageKey(taskName: string): string {
  return createHash("sha256").update(taskName).digest("hex").slice(0, 24);
}

function runsRoots(): string[] {
  return [...new Set([getRunsDir(), LEGACY_RUNS_DIR])];
}

function scopeDir(parentSessionId: string): string {
  return path.join(getRunsDir(), parentScopeKey(parentSessionId));
}

function scopeDirs(parentSessionId: string): string[] {
  const key = parentScopeKey(parentSessionId);
  return runsRoots().map((root) => path.join(root, key));
}

function normalizeTaskName(name: string): string {
  const normalized = name.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(normalized)) {
    throw new Error("task_name must use letters, digits, underscores, dashes, and optional slash path separators");
  }
  return normalized;
}

export function normalizeContextUsage(value: unknown): ContextUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { contextWindow, tokens, percent } = value as Record<string, unknown>;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const validUsage = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
    && typeof percent === "number" && Number.isFinite(percent) && percent >= 0;
  return { contextWindow, tokens: validUsage ? tokens : null, percent: validUsage ? percent : null };
}

export function formatContextUsage(value: unknown): string {
  const usage = normalizeContextUsage(value);
  if (!usage) return "?%/?";
  const { contextWindow, percent } = usage;
  const window = contextWindow >= 1_000_000
    ? `${Number((contextWindow / 1_000_000).toFixed(2))}M`
    : contextWindow >= 1_000
      ? `${Number((contextWindow / 1_000).toFixed(2))}k`
      : String(contextWindow);
  const occupied = percent === null ? "?" : percent > 0 && percent < 0.1 ? "<0.1" : String(Number(percent.toFixed(1)));
  return `${occupied}%/${window}`;
}

function sameContextUsage(a: ContextUsage | undefined, b: ContextUsage | undefined): boolean {
  return a?.contextWindow === b?.contextWindow && a?.tokens === b?.tokens && a?.percent === b?.percent;
}

function saveInfo(info: AgentInfo): void {
  fs.mkdirSync(path.dirname(info.infoFile), { recursive: true });
  info.updatedAt = Date.now();
  const temporary = `${info.infoFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(info, null, 2));
  fs.renameSync(temporary, info.infoFile);
}

export function readInfoFile(file: string): AgentInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8")) as Omit<AgentInfo, "status"> & { status: AgentRuntimeStatus | "closed"; closedAt?: number };
    if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
    const contextUsage = normalizeContextUsage(info.contextUsage);
    if (contextUsage) info.contextUsage = contextUsage;
    else delete info.contextUsage;
    if (info.status === "closed") {
      info.status = info.error ? "failed" : info.finalResponse !== undefined ? "completed" : "interrupted";
      delete info.closedAt;
    }
    // Legacy RPC ownership is not SDK ownership and must never be acted on.
    delete (info as any).childProcess;
    return info as AgentInfo;
  } catch {
    return undefined;
  }
}

function readInfos(directory: string): AgentInfo[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".info.json"))
    .flatMap((name) => {
      const info = readInfoFile(path.join(directory, name));
      return info ? [info] : [];
    });
}

function sortInfos(infos: AgentInfo[]): AgentInfo[] {
  return infos.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

function readScopeInfos(parentSessionId: string): AgentInfo[] {
  return sortInfos(scopeDirs(parentSessionId).flatMap(readInfos));
}

function readAllInfos(): AgentInfo[] {
  const directories = runsRoots().flatMap((root) => {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SCOPE_DIR_PATTERN.test(entry.name))
      .map((entry) => path.join(root, entry.name));
  });
  return sortInfos(directories.flatMap(readInfos));
}

export function getAgent(name: string, parentSessionId: string): AgentInfo | null {
  const taskName = normalizeTaskName(name);
  return readScopeInfos(parentSessionId).find((info) => info.taskName === taskName) ?? null;
}

export function parseAgentDefinitionText(text: string, fallbackName: string): AgentDefinition {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const attrs: Record<string, string> = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
      if (entry) attrs[entry[1]] = entry[2].replace(/^['"]|['"]$/g, "");
    }
  }
  return {
    name: attrs.name || fallbackName,
    description: attrs.description,
    hint: attrs.hint || attrs.caller_hint,
    provider: attrs.provider?.trim() || undefined,
    model: attrs.model?.trim() || undefined,
    thinking: isThinkingLevel(attrs.thinking) ? attrs.thinking : undefined,
    tools: attrs.tools,
    skills: stringList(attrs.skills),
    extensions: stringList(attrs.extensions),
    prompt: (match ? text.slice(match[0].length) : text).trim() || undefined,
  };
}

export function listAgentDefinitions(): AgentDefinition[] {
  ensureBaseDirs();
  const definitions: AgentDefinition[] = [];
  for (const name of fs.readdirSync(AGENTS_DIR)) {
    if (!name.endsWith(".md")) continue;
    try {
      definitions.push(parseAgentDefinitionText(fs.readFileSync(path.join(AGENTS_DIR, name), "utf8"), name.replace(/\.md$/, "")));
    } catch {}
  }
  return definitions.sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgentDefinition(name?: string): AgentDefinition | undefined {
  return name ? listAgentDefinitions().find((definition) => definition.name === name) : undefined;
}

export function getAgentDefinitionsDescription(): string {
  const definitions = listAgentDefinitions();
  if (!definitions.length) return "None configured, so omit `agent_type`.";
  return definitions.map((definition) => {
    let line = `- \`${definition.name}\`${definition.description ? ` — ${definition.description}` : ""}`;
    if (definition.model) line += ` — model: ${definition.provider ? `${definition.provider}/${definition.model}` : `${definition.model} (inherited provider)`}`;
    if (definition.thinking) line += ` — thinking: ${definition.thinking}`;
    if (definition.extensions?.length) line += ` — extensions: ${definition.extensions.join(", ")}`;
    return definition.hint ? `${line}\n  Caller hint: ${definition.hint}` : line;
  }).join("\n");
}

function normalizeTools(tools: string | undefined): string {
  if (tools === undefined) return DEFAULT_TOOLS;
  return tools.split(",").map((tool) => tool.trim()).filter(Boolean).join(",");
}

function normalizeList(values?: string[]): string[] | undefined {
  const normalized = Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
  return normalized.length ? normalized : undefined;
}

function findNearestSkillDirs(cwd: string): string[] {
  const directories: string[] = [];
  let current = cwd;
  while (true) {
    directories.push(path.join(current, CONFIG_DIR_NAME, "skills"));
    directories.push(path.join(current, ".agents", "skills"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function parseSkillName(content: string): string | undefined {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatter = match?.[1] ?? content.slice(0, 2048);
  return frontmatter.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
}

function resolveSkillPath(skill: string, cwd: string): string {
  const expanded = expandHome(skill);
  if (path.isAbsolute(expanded) || expanded.startsWith(".")) {
    const candidate = path.resolve(cwd, expanded);
    if (fs.existsSync(candidate)) return candidate;
    throw new Error(`Skill path not found: ${skill}`);
  }
  const npmRoot = path.join(getAgentDir(), "npm", "node_modules");
  const roots = [path.join(getAgentDir(), "skills"), path.join(os.homedir(), ".agents", "skills"), ...findNearestSkillDirs(cwd), npmRoot];
  for (const root of roots) {
    const directDirectory = path.join(root, skill);
    if (fs.existsSync(path.join(directDirectory, "SKILL.md"))) return directDirectory;
    const directMarkdown = path.join(root, `${skill}.md`);
    if (fs.existsSync(directMarkdown)) return directMarkdown;
  }
  const stack = fs.existsSync(npmRoot) ? [npmRoot] : [];
  while (stack.length) {
    const directory = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    const skillFile = path.join(directory, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      try {
        if (parseSkillName(fs.readFileSync(skillFile, "utf8")) === skill) return directory;
      } catch {}
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" && directory !== npmRoot) continue;
      stack.push(path.join(directory, entry.name));
    }
  }
  throw new Error(`Skill not found: ${skill}`);
}

function resolveSkillPaths(skills: string[] | undefined, cwd: string, loadedSkillPaths?: Record<string, string>): string[] | undefined {
  return skills?.map((skill) => loadedSkillPaths?.[skill] ?? resolveSkillPath(skill, cwd));
}

function looksLikePath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith(".") || path.isAbsolute(value);
}

function resolveExtensionPath(extension: string, cwd: string): string {
  if (looksLikePath(extension)) {
    const expanded = expandHome(extension);
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
    if (!fs.existsSync(resolved)) throw new Error(`Extension path not found: ${extension}`);
    return resolved;
  }
  const candidates = [
    path.join(cwd, CONFIG_DIR_NAME, "npm", "node_modules", extension),
    path.join(getAgentDir(), "npm", "node_modules", extension),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) throw new Error(`Installed extension package not found: ${extension}. Install it with pi install first.`);
  return resolved;
}

function resolveExtensionPaths(extensions: string[] | undefined, cwd: string): string[] | undefined {
  return extensions?.map((extension) => resolveExtensionPath(extension, cwd));
}

export interface PeekMarker { pid: number; startedAt: number; token: string }

export function getSocketPath(agentId: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${PACKAGE_BASENAME}-${os.userInfo().username}-${agentId}`
    : path.join(SOCKET_DIR, `${agentId}.sock`);
}

function markerPath(agentId: string, kind: "active" | "peek"): string {
  return path.join(SOCKET_DIR, `${agentId}.${kind}.json`);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "EPERM"; }
}

function markActive(agentId: string, kind: "active" | "peek", marker: PeekMarker): void {
  fs.writeFileSync(markerPath(agentId, kind), JSON.stringify(marker, null, 2));
}

function clearActive(agentId: string, kind: "active" | "peek", owner?: Pick<PeekMarker, "pid" | "token">): void {
  const file = markerPath(agentId, kind);
  try {
    if (owner && fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, "utf8"));
      if (current.pid !== owner.pid || current.token !== owner.token) return;
    }
    fs.unlinkSync(file);
  } catch {}
}

function isActive(agentId: string, kind: "active" | "peek"): boolean {
  const file = markerPath(agentId, kind);
  try {
    if (!fs.existsSync(file)) return false;
    const marker = JSON.parse(fs.readFileSync(file, "utf8")) as PeekMarker;
    if (processAlive(marker.pid)) return true;
    clearActive(agentId, kind, marker);
  } catch {
    clearActive(agentId, kind);
  }
  return false;
}

function isRunActive(agentId: string): boolean {
  return isActive(agentId, "active") || isActive(agentId, "peek");
}

export function isPeekActive(agentId: string): boolean {
  return isActive(agentId, "peek");
}

class SessionLogger {
  private stream: fs.WriteStream | null = null;
  private closed = false;
  constructor(private readonly file: string, private readonly onError: (error: Error) => void) {}
  write(level: string, category: string, message: string, data?: any): void {
    if (this.closed) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!this.stream) {
      const stream = fs.createWriteStream(this.file, { flags: "a" });
      stream.on("error", (error) => {
        if (this.stream === stream) this.stream = null;
        this.onError(error);
      });
      this.stream = stream;
    }
    this.stream.write(JSON.stringify({ ts: new Date().toISOString(), level, category, message, ...(data !== undefined ? { data } : {}) }) + "\n");
    if (process.env.PI_SUBAGENT_DEBUG) console.error(`[${level}] ${category}: ${message}`, data ?? "");
  }
  info(category: string, message: string, data?: any): void { this.write("INFO", category, message, data); }
  close(): void { this.closed = true; this.stream?.end(); this.stream = null; }
}

export type RpcAssistantStreamStatus = "thinking" | "streaming" | "calling";

export class RpcAssistantStreamState {
  status: RpcAssistantStreamStatus = "thinking";
  message: AssistantMessage | null = null;
  private readonly toolArguments = new Map<number, string>();

  start(message: AssistantMessage): void {
    this.message = message;
    this.status = "thinking";
    this.toolArguments.clear();
  }

  update(delta: any, cumulativeMessage?: AssistantMessage): void {
    if (cumulativeMessage?.role === "assistant") {
      this.message = cumulativeMessage;
    } else if (this.message) {
      this.applyDelta(delta);
    }
    if (delta?.type === "thinking_start" || delta?.type === "thinking_delta" || delta?.type === "thinking_end") {
      this.status = "thinking";
    } else if (delta?.type === "text_start" || delta?.type === "text_delta" || delta?.type === "text_end") {
      this.status = "streaming";
    } else if (delta?.type === "toolcall_start" || delta?.type === "toolcall_delta" || delta?.type === "toolcall_end") {
      this.status = "calling";
    }
  }

  resume(
    message: AssistantMessage,
    status: RpcAssistantStreamStatus,
    toolArguments: Array<[number, string]> = [],
  ): void {
    this.message = message;
    this.status = status;
    this.toolArguments.clear();
    for (const [index, raw] of toolArguments) {
      if (Number.isInteger(index) && index >= 0 && typeof raw === "string") this.toolArguments.set(index, raw);
    }
  }

  snapshotToolArguments(): Array<[number, string]> {
    return [...this.toolArguments.entries()];
  }

  finish(message?: AssistantMessage): void {
    if (message?.role === "assistant") this.message = message;
    this.toolArguments.clear();
  }

  clear(): void {
    this.message = null;
    this.toolArguments.clear();
  }

  private applyDelta(delta: any): void {
    if (!this.message || !Number.isInteger(delta?.contentIndex) || delta.contentIndex < 0) return;
    const index = delta.contentIndex;
    const content = this.message.content as any[];
    if (delta.type === "thinking_start") {
      content[index] = { type: "thinking", thinking: "" };
    } else if (delta.type === "thinking_delta") {
      const block = content[index]?.type === "thinking" ? content[index] : { type: "thinking", thinking: "" };
      block.thinking += typeof delta.delta === "string" ? delta.delta : "";
      content[index] = block;
    } else if (delta.type === "thinking_end") {
      content[index] = { type: "thinking", thinking: typeof delta.content === "string" ? delta.content : "" };
    } else if (delta.type === "text_start") {
      content[index] = { type: "text", text: "" };
    } else if (delta.type === "text_delta") {
      const block = content[index]?.type === "text" ? content[index] : { type: "text", text: "" };
      block.text += typeof delta.delta === "string" ? delta.delta : "";
      content[index] = block;
    } else if (delta.type === "text_end") {
      content[index] = { type: "text", text: typeof delta.content === "string" ? delta.content : "" };
    } else if (delta.type === "toolcall_start") {
      this.toolArguments.set(index, "");
      content[index] = { type: "toolCall", id: delta.id ?? `streaming-${index}`, name: delta.toolName ?? "tool", arguments: {} };
    } else if (delta.type === "toolcall_delta") {
      const raw = `${this.toolArguments.get(index) ?? ""}${typeof delta.delta === "string" ? delta.delta : ""}`;
      this.toolArguments.set(index, raw);
      const block = content[index]?.type === "toolCall"
        ? content[index]
        : { type: "toolCall", id: `streaming-${index}`, name: "tool", arguments: {} };
      block.arguments = parseStreamingJson(raw);
      content[index] = block;
    } else if (delta.type === "toolcall_end" && delta.toolCall?.type === "toolCall") {
      this.toolArguments.delete(index);
      content[index] = delta.toolCall;
    }
  }
}

/** Preserve the existing observation protocol without sharing its mutable delta cache with SDK. */
export function toObserverEvent(event: AgentSessionEvent): any {
  if (event.type === "message_start" && event.message.role === "assistant") {
    return { ...event, message: structuredClone(event.message) };
  }
  if (event.type !== "message_update") return event;
  if (event.message.role !== "assistant") throw new Error("SDK message_update is not an assistant message.");
  const update = event.assistantMessageEvent;
  if (!("partial" in update)) return { type: "message_update", usage: event.message.usage, assistantMessageEvent: update };
  const { partial, ...delta } = update;
  if (delta.type === "toolcall_start") {
    const toolCall = partial.content[delta.contentIndex];
    if (toolCall?.type !== "toolCall") throw new Error("SDK toolcall_start is missing its tool call.");
    return { type: "message_update", usage: event.message.usage, assistantMessageEvent: { ...delta, id: toolCall.id, toolName: toolCall.name } };
  }
  return { type: "message_update", usage: event.message.usage, assistantMessageEvent: delta };
}

export class EventBroadcaster {
  private server: net.Server | null = null;
  private connections: net.Socket[] = [];
  private readonly marker: PeekMarker = { pid: process.pid, startedAt: Date.now(), token: randomUUID() };
  private status: RpcAssistantStreamStatus | "tool" | "done" = "thinking";
  private toolName?: string;
  private readonly assistantStream = new RpcAssistantStreamState();
  private userMessage: any = null;
  private readonly activeTools = new Map<string, { toolCallId: string; toolName: string; args: any; partialResult?: any; result?: any; isError?: boolean }>();

  constructor(private readonly agentId: string, private readonly onError: (error: Error) => void = () => {}) {}

  start(): void {
    try {
      ensurePrivateDir(SOCKET_DIR, true);
      markActive(this.agentId, "active", this.marker);
    } catch (error) {
      clearActive(this.agentId, "active");
      throw error;
    }
    const socketPath = getSocketPath(this.agentId);
    if (process.platform !== "win32") {
      try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch {}
    }
    const server = this.server = net.createServer((connection) => {
      this.connections.push(connection);
      try {
        connection.write(JSON.stringify({
          type: "sync",
          status: this.status,
          toolName: this.toolName,
          partialMessage: this.assistantStream.message,
          toolArguments: this.assistantStream.snapshotToolArguments(),
          userMessage: this.userMessage,
          activeTools: [...this.activeTools.values()],
        }) + "\n");
      } catch {}
      const remove = () => { this.connections = this.connections.filter((candidate) => candidate !== connection); };
      connection.on("close", remove);
      connection.on("error", remove);
    });
    server.on("listening", () => {
      if (this.server !== server) return;
      try { markActive(this.agentId, "peek", this.marker); } catch (error) {
        this.stopSocket();
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    server.on("error", (error) => {
      if (this.server !== server) return;
      this.stopSocket();
      this.onError(error);
    });
    try { server.listen(socketPath); } catch (error) {
      this.stopSocket();
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  broadcast(event: any): void {
    const isToolExecution =
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end";

    // Only top-level calls get observer rows; parents carry nested progress in their own results.
    if (isToolExecution && event.parentToolCallId) return;

    if (event.type === "message_start" && event.message?.role === "user") {
      this.userMessage = event.message;
    } else if (event.type === "message_start" && event.message?.role === "assistant") {
      this.assistantStream.start(event.message);
      this.status = "thinking";
    } else if (event.type === "message_update") {
      this.assistantStream.update(event.assistantMessageEvent, event.message);
      this.status = this.assistantStream.status;
    } else if (event.type === "tool_execution_start") {
      this.status = "tool";
      this.toolName = event.toolName;
      if (event.toolCallId) {
        this.activeTools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
      }
    } else if (event.type === "tool_execution_update" && event.toolCallId) {
      const active = this.activeTools.get(event.toolCallId);
      if (active) active.partialResult = event.partialResult;
    } else if (event.type === "tool_execution_end" && event.toolCallId) {
      const active = this.activeTools.get(event.toolCallId);
      if (active) {
        active.result = {
          ...event.result,
          durationMs: event.durationMs ?? event.result?.durationMs,
        };
        active.isError = event.isError ?? false;
      }
    } else if (event.type === "message_end") {
      if (event.message?.role === "assistant") this.assistantStream.finish(event.message);
      if (event.message?.role === "toolResult" && event.message.toolCallId) {
        this.activeTools.delete(event.message.toolCallId);
      }
      this.assistantStream.clear();
      this.userMessage = null;
    } else if (event.type === "agent_settled") {
      this.assistantStream.clear();
      this.userMessage = null;
      this.activeTools.clear();
      this.status = "done";
      this.toolName = undefined;
    }
    const line = JSON.stringify(event) + "\n";
    for (const connection of this.connections) {
      try { connection.write(line); } catch {}
    }
  }

  private stopSocket(): void {
    clearActive(this.agentId, "peek", this.marker);
    for (const connection of this.connections) {
      try { connection.destroy(); } catch {}
    }
    this.connections = [];
    try { this.server?.close(); } catch {}
    this.server = null;
    if (process.platform !== "win32") {
      try { if (fs.existsSync(getSocketPath(this.agentId))) fs.unlinkSync(getSocketPath(this.agentId)); } catch {}
    }
  }

  stop(): void {
    clearActive(this.agentId, "active", this.marker);
    this.stopSocket();
  }
}

function extractTextFromMessage(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n\n");
}

function previewText(text: string | undefined, maxLength = 180): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function canonicalAgentName(target: string): string {
  return target.startsWith("/") ? target : `/${target}`;
}

function targetMatches(event: AgentCompletionEvent, targets?: Set<string>): boolean {
  return !targets || targets.has(event.agentName);
}

export function consumeFirstMatchingMailboxEvent(events: AgentCompletionEvent[], parentSessionId: string, targets?: Set<string>): AgentCompletionEvent | undefined {
  const index = events.findIndex((event) => event.parentSessionId === parentSessionId && targetMatches(event, targets));
  if (index === -1) return undefined;
  return events.splice(index, 1)[0];
}

export class AgentManager {
  private readonly live = new Map<string, LiveAgent>();
  private readonly mailbox: AgentCompletionEvent[] = [];
  private waiters: Waiter[] = [];
  private readonly waitAllClaims = new Set<{
    parentSessionId: string;
    targets: Set<string>;
    suppressedEventIds: Set<string>;
  }>();
  private readonly defaultWaitAllTargets = new Map<string, Set<string>>();
  private readonly shutdownController = new AbortController();
  private readonly reconciliation: Promise<void>;

  constructor(private readonly options: AgentManagerOptions = {}) {
    ensureBaseDirs();
    pruneExpiredRuns();
    this.reconciliation = this.reconcileInactiveRuns();
    // A caller may not invoke ready() until a later event.
    void this.reconciliation.catch(() => {});
    const nativeSessions = path.join(getAgentDir(), "sessions");
    const storage = getRunsDir();
    const overlaps = (a: string, b: string) => {
      const relative = path.relative(a, b);
      return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };
    if (overlaps(nativeSessions, storage) || overlaps(storage, nativeSessions)) {
      this.reportError(undefined, new Error("Subagent storageDir overlaps Pi's native session directory; child sessions may appear in /resume."));
    }
  }

  async ready(): Promise<void> {
    await this.reconciliation;
  }

  private notifyStatusChange(info: AgentInfo): void {
    try {
      this.options.onActivityChange?.({
        parentSessionId: info.parentSessionId,
        agentName: info.canonicalName,
        active: info.status === "starting" || info.status === "running",
      });
    } catch (error) { this.reportError(undefined, error); }
  }

  private notifyUnclaimedCompletion(event: AgentCompletionEvent): void {
    try { this.options.onUnclaimedCompletion?.(event); } catch (error) { this.reportError(undefined, error); }
  }

  private reportError(live: LiveAgent | undefined, error: unknown): void {
    const detail = error as { extensionPath?: string; event?: string; error?: unknown } | undefined;
    const failure = error instanceof Error ? error : new Error(
      detail && typeof detail === "object" && "error" in detail
        ? `${detail.extensionPath ?? "child extension"}${detail.event ? ` (${detail.event})` : ""}: ${formatAgentError(detail.error)}`
        : formatAgentError(error));
    try { live?.logger.info("error", failure.message); } catch {}
    try {
      if (this.options.onError) this.options.onError(failure);
      else console.error(`[subagents] ${formatAgentError(failure)}`);
    } catch {}
  }

  private async reconcileInactiveRuns(): Promise<void> {
    for (const info of readAllInfos()) {
      if ((info.status === "starting" || info.status === "running") && !isRunActive(info.id)) {
        info.status = "interrupted";
        info.completedAt = Date.now();
        info.lastActivity = Date.now();
        saveInfo(info);
        this.notifyStatusChange(info);
      }
    }
  }

  async spawnAgent(params: SpawnAgentParams): Promise<{ task_name: string; nickname: null }> {
    throwIfAborted(this.shutdownController.signal);
    await this.reconciliation;
    throwIfAborted(this.shutdownController.signal);
    const taskName = normalizeTaskName(params.task_name);
    const definition = getAgentDefinition(params.agent_type);
    if (params.agent_type && !definition) throw new Error(`Agent template not found: ${params.agent_type}`);
    const templateModel = definition?.model ? { provider: definition.provider ?? params.inheritedProvider, modelId: definition.model } : undefined;
    const { provider, modelId } = params.model ?? templateModel ?? { provider: params.inheritedProvider, modelId: params.inheritedModelId };
    const config = loadSubagentConfig();
    readSystemPrompt();
    const configuredSkills = definition?.skills ?? config.defaults?.skills;
    const skills = normalizeList([...(configuredSkills ?? []), ...(params.skills ?? [])]);
    const extensions = normalizeList(definition?.extensions ?? config.defaults?.extensions);
    const tools = definition?.tools !== undefined
      ? normalizeTools(definition.tools)
      : extensions?.length
        ? undefined
        : normalizeTools(params.inheritedTools);
    const thinking = params.thinking ?? definition?.thinking ?? params.inheritedThinking ?? DEFAULT_THINKING;
    const cwd = path.resolve(params.cwd);
    const directory = scopeDir(params.parentSessionId);
    ensurePrivateDir(directory, true);

    const lockFile = path.join(directory, `.task-${taskStorageKey(taskName)}.lock`);
    let lock: number | undefined;
    try {
      try {
        lock = fs.openSync(lockFile, "wx");
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } catch (error: any) {
        if (error?.code === "EEXIST") throw new Error(`Agent ${taskName} is already being created.`);
        throw error;
      }
      if (readScopeInfos(params.parentSessionId).some((info) => info.taskName === taskName)) {
        throw new Error(`Agent ${taskName} already exists in this parent session. Use a new task_name.`);
      }
      const id = randomUUID();
      const info: AgentInfo = {
        id,
        taskName,
        canonicalName: `/${taskName}`,
        parentSessionId: params.parentSessionId,
        parentSessionFile: params.parentSessionFile,
        agentType: params.agent_type,
        provider,
        modelId,
        model: `${provider}:${modelId}`,
        thinking,
        tools,
        skills,
        skillPaths: resolveSkillPaths(skills, cwd, params.loadedSkillPaths),
        extensions,
        extensionPaths: resolveExtensionPaths(extensions, cwd),
        cwd,
        sessionFile: path.join(directory, `${id}.jsonl`),
        infoFile: path.join(directory, `${id}.info.json`),
        logFile: path.join(directory, `${id}.log`),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: Date.now(),
        lastActivity: Date.now(),
        messageCount: 0,
        status: "starting",
        lastTaskMessage: params.message,
      };
      saveInfo(info);
      this.notifyStatusChange(info);
      const targets = this.defaultWaitAllTargets.get(params.parentSessionId) ?? new Set<string>();
      targets.add(info.canonicalName);
      this.defaultWaitAllTargets.set(params.parentSessionId, targets);
      const prompt = [definition?.prompt, params.message].filter(Boolean).join("\n\n");
      try {
        await this.startLiveAgent(info, prompt, params.message);
      } catch (error) {
        const message = formatAgentError(error);
        if (error instanceof Error && error.message === message) throw error;
        throw new Error(message, { cause: error });
      }
      return { task_name: info.canonicalName, nickname: null };
    } finally {
      if (lock !== undefined) {
        fs.closeSync(lock);
        try { fs.unlinkSync(lockFile); } catch {}
      }
    }
  }

  private async startLiveAgent(info: AgentInfo, message: string, displayMessage = message): Promise<LiveAgent> {
    throwIfAborted(this.shutdownController.signal);
    if (this.live.has(info.id)) throw new Error(`Agent ${info.canonicalName} already has a live session. Retry after startup finishes.`);
    if (isRunActive(info.id)) throw new Error(`Agent ${info.canonicalName} is active in another host; refusing to reopen its session file.`);
    const previous = { ...info };
    const live: LiveAgent = {
      info,
      broadcaster: new EventBroadcaster(info.id, (error) => this.reportError(undefined, error)),
      logger: new SessionLogger(info.logFile, (error) => this.reportError(undefined, error)),
      cancellation: new AbortController(),
      closing: false,
      finalizedRun: false,
      awaitingPrompt: true,
      accepted: false,
      candidateResponse: "",
      settledAborted: false,
      pendingSteers: new Set(),
      lastActivityPersistedAt: info.updatedAt,
    };
    // Register before the first asynchronous initialization step, including session_start.
    this.live.set(info.id, live);
    const checkCanceled = () => {
      throwIfAborted(this.shutdownController.signal);
      throwIfAborted(live.cancellation.signal);
      if (live.eventError) throw live.eventError;
      if (live.closing || this.live.get(info.id) !== live) throw new Error("Child session is closing.");
    };
    const timeout = new Error(`Timed out waiting for agent ${info.canonicalName} initialization or prompt acceptance.`);
    let wasWaitAllTarget = false;
    try {
      ensureSystemPromptFile();
      live.broadcaster.start();
      info.status = "starting";
      info.lastActivity = Date.now();
      saveInfo(info);
      this.notifyStatusChange(info);
      live.initialization = createChildSession({
        info,
        systemPromptPath: SYSTEM_PROMPT_PATH,
        projectTrusted: this.options.projectTrusted?.(info.cwd),
        checkCanceled,
        onCreated: (session) => {
          live.session = session;
          live.unsubscribe = session.subscribe((event) => {
            // SDK persists message_end AFTER public listeners. Never throw back into it.
            try {
              this.handleSessionEvent(live, event);
            } catch (error) {
              live.eventError ??= error instanceof Error ? error : new Error(formatAgentError(error));
              this.reportError(live, error);
              this.requestAbort(live);
            }
          });
        },
        onError: (error) => this.reportError(live, error),
        onShutdown: () => {
          this.requestCancellation(live, new Error("Child extension requested shutdown."));
          try { this.markInterrupted(live); } catch (error) { this.reportError(live, error); }
          finally { this.scheduleTermination(live); }
        },
        log: (text) => live.logger.info("sdk", text),
      });
      const startup = live.initialization.then(async () => {
        checkCanceled();
        wasWaitAllTarget = this.defaultWaitAllTargets.get(info.parentSessionId)?.has(info.canonicalName) ?? false;
        await this.prompt(live, message, displayMessage);
      });
      await boundedWait(startup, DEFAULT_STARTUP_TIMEOUT_MS, timeout, live.cancellation.signal);
      return live;
    } catch (error) {
      if (error === timeout) this.requestCancellation(live, timeout);
      try {
        // Only a rejected, unaccepted resume can restore the previous result. Cancellation,
        // timeout and an accepted run own their terminal result, even before input returns.
        if (live.promptFinished && !live.accepted && !live.finalizedRun && !live.cancellation.signal.aborted
          && !this.shutdownController.signal.aborted && this.live.get(info.id) === live
          && FINAL_STATUSES.has(previous.status)) {
          live.info = previous;
          live.finalizedRun = true;
          try { saveInfo(previous); } finally {
            if (!wasWaitAllTarget) this.finishWaitTarget(previous.parentSessionId, previous.canonicalName);
            const completion = live.suspendedCompletion;
            delete live.suspendedCompletion;
            if (completion) this.pushMailbox(completion, false);
            else {
              // A targeted wait can reread a terminal snapshot. That is not a new mailbox
              // event and must not satisfy an unscoped next-completion wait.
              for (const waiter of this.waiters.filter((waiter) =>
                waiter.parentSessionId === previous.parentSessionId && waiter.targets?.has(previous.canonicalName))) {
                waiter.resolve({
                  id: randomUUID(), parentSessionId: previous.parentSessionId, agentName: previous.canonicalName,
                  status: previous.status, finalResponse: previous.finalResponse, error: previous.error, createdAt: Date.now(),
                });
              }
            }
            // Observers may synchronously consume the restored result.
            this.notifyStatusChange(previous);
          }
        } else if (!live.finalizedRun) {
          if (this.shutdownController.signal.aborted || (live.cancellation.signal.aborted && error !== timeout)) this.markInterrupted(live);
          else this.markFailed(live, formatAgentError(error));
        }
      } catch (saveError) {
        this.reportError(live, saveError);
      } finally {
        try { await this.waitForTermination(live); } catch (cleanupError) { this.reportError(live, cleanupError); }
      }
      throw error;
    }
  }

  private async prompt(live: LiveAgent, message: string, displayMessage: string): Promise<void> {
    const session = live.session!;
    live.suspendedCompletion = consumeFirstMatchingMailboxEvent(this.mailbox, live.info.parentSessionId,
      new Set([live.info.canonicalName]));
    const targets = this.defaultWaitAllTargets.get(live.info.parentSessionId) ?? new Set<string>();
    targets.add(live.info.canonicalName);
    this.defaultWaitAllTargets.set(live.info.parentSessionId, targets);
    live.info.status = "running";
    live.info.lastTaskMessage = displayMessage;
    live.info.lastActivity = Date.now();
    live.info.messageCount += 1;
    delete live.info.finalResponse;
    delete live.info.error;
    delete live.info.completedAt;
    saveInfo(live.info);
    live.lastActivityPersistedAt = live.info.updatedAt;
    this.notifyStatusChange(live.info);

    let resolveAccepted!: () => void;
    let rejectAccepted!: (error: unknown) => void;
    const accepted = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    throwIfAborted(this.shutdownController.signal);
    throwIfAborted(live.cancellation.signal);
    if (live.closing) throw new Error("Child session is closing.");
    const promptFinished = promptChildSession(session, message, () => {
      delete live.suspendedCompletion;
      live.accepted = true;
      resolveAccepted();
    });
    // Track the ORIGINAL operation, not the completion/cleanup wrapper (which would deadlock).
    live.promptFinished = promptFinished;
    const finished = promptFinished.then(() => session.waitForIdle());
    void finished.then(() => {
      if (!live.accepted) rejectAccepted(new Error("Child prompt returned without an acceptance result."));
      else this.finishRun(live);
    }, (error) => {
      rejectAccepted(error);
      if (live.accepted) this.finishRun(live, error);
    });
    await accepted;
    // abort() during input/preflight can return idle before this operation starts. Request it
    // again after a late acceptance, without ever reviving a finalized/very fast completed run.
    if (live.cancellation.signal.aborted || this.shutdownController.signal.aborted) {
      this.requestAbort(live);
      throw abortError(live.cancellation.signal.aborted ? live.cancellation.signal : this.shutdownController.signal);
    }
    if (this.live.get(live.info.id) === live && !live.closing && !live.finalizedRun) live.awaitingPrompt = false;
  }

  private finishRun(live: LiveAgent, error?: unknown): void {
    if (this.live.get(live.info.id) !== live) return;
    live.closing = true;
    this.clearModelResponseTimer(live);
    try {
      this.sampleContextUsage(live);
      if (live.finalizedRun) return;
      const failure = live.eventError ?? error ?? live.candidateError
        ?? (live.settledAborted ? "Agent ended with aborted." : undefined);
      if (failure !== undefined) this.markFailed(live, formatAgentError(failure));
      else this.markCompleted(live);
    } catch (error) {
      this.reportError(live, error);
    } finally {
      this.scheduleTermination(live);
    }
  }

  private sampleContextUsage(live: LiveAgent): void {
    if (this.live.get(live.info.id) !== live || !live.session) return;
    try {
      const contextUsage = normalizeContextUsage(live.session.getContextUsage());
      if (sameContextUsage(live.info.contextUsage, contextUsage)) return;
      const candidate = { ...live.info };
      if (contextUsage) candidate.contextUsage = contextUsage;
      else delete candidate.contextUsage;
      saveInfo(candidate);
      Object.assign(live.info, candidate);
      if (!contextUsage) delete live.info.contextUsage;
    } catch (error) {
      // Context sampling is best-effort; persistence failures remain visible, but must not
      // prevent result delivery or release of the session.
      this.reportError(live, error);
    }
  }

  private clearModelResponseTimer(live: LiveAgent): void {
    if (live.modelResponseTimer !== undefined) clearTimeout(live.modelResponseTimer);
    delete live.modelResponseTimer;
  }

  private startModelResponseTimer(live: LiveAgent): void {
    this.clearModelResponseTimer(live);
    if (live.closing || live.finalizedRun) return;
    const timeoutMs = Math.max(
      0,
      this.options.modelResponseTimeoutMs ?? loadSubagentConfig().modelResponseTimeoutMs ?? DEFAULT_MODEL_RESPONSE_TIMEOUT_MS,
    );
    if (timeoutMs === 0) return;
    live.modelResponseTimer = setTimeout(() => {
      delete live.modelResponseTimer;
      if (this.live.get(live.info.id) !== live || live.closing || live.finalizedRun) return;
      const error = `Model response exceeded ${timeoutMs} ms without completing.`;
      this.requestCancellation(live, new Error(error));
      try { this.markFailed(live, error); } catch (error) { this.reportError(live, error); }
      finally { this.scheduleTermination(live); }
    }, timeoutMs);
    live.modelResponseTimer.unref?.();
  }

  private handleSessionEvent(live: LiveAgent, event: AgentSessionEvent): void {
    if (this.live.get(live.info.id) !== live) return;
    live.broadcaster.broadcast(toObserverEvent(event));
    if (event.type === "agent_start" && (live.closing || live.cancellation.signal.aborted || live.eventError)) this.requestAbort(live);
    if (live.finalizedRun || (live.awaitingPrompt && !live.promptFinished)) return;
    // These are persisted boundaries. message_end is deliberately NOT one: SDK appends the
    // message after this callback and a synchronous sample there would lag by one message.
    if (event.type === "turn_end" || (event.type === "compaction_end" && event.result)
      || (event.type === "entry_appended" && ["context_edit", "compaction", "message", "custom_message"].includes(event.entry.type))) {
      this.sampleContextUsage(live);
    }
    if (event.type === "agent_settled") {
      live.settledAborted = event.aborted;
      this.clearModelResponseTimer(live);
      return;
    }
    if (live.closing) return;
    if (event.type === "agent_start") {
      live.info.status = "running";
      live.info.lastActivity = Date.now();
      saveInfo(live.info);
      live.lastActivityPersistedAt = live.info.updatedAt;
      this.notifyStatusChange(live.info);
    } else if (event.type === "message_start" && event.message.role === "assistant") {
      this.startModelResponseTimer(live);
    } else if (event.type === "message_update" || event.type === "tool_execution_update") {
      live.info.lastActivity = Date.now();
      if (live.info.lastActivity - live.lastActivityPersistedAt >= ACTIVITY_PERSIST_INTERVAL_MS) {
        saveInfo(live.info);
        live.lastActivityPersistedAt = live.info.updatedAt;
      }
    } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      live.info.lastActivity = Date.now();
      saveInfo(live.info);
      live.lastActivityPersistedAt = live.info.updatedAt;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      this.clearModelResponseTimer(live);
      live.candidateResponse = extractTextFromMessage(event.message).trim();
      live.candidateError = event.message.stopReason === "error" || event.message.stopReason === "aborted"
        ? event.message.errorMessage || `Agent ended with ${event.message.stopReason}.`
        : undefined;
    } else if (event.type === "auto_retry_end" && !event.success && event.finalError) {
      live.candidateError = event.finalError;
    }
  }

  private markCompleted(live: LiveAgent): void { this.finalizeRun(live, "completed"); }

  private markFailed(live: LiveAgent, error: string): void { this.finalizeRun(live, "failed", error); }

  private markInterrupted(live: LiveAgent): void { this.finalizeRun(live, "interrupted"); }

  private finalizeRun(live: LiveAgent, status: "completed" | "failed" | "interrupted", error?: string): void {
    if (this.live.get(live.info.id) !== live || live.finalizedRun) return;
    // Close the admission boundary BEFORE persistence, callbacks and completion publication.
    live.closing = true;
    live.finalizedRun = true;
    delete live.suspendedCompletion;
    this.clearModelResponseTimer(live);
    live.info.status = status;
    if (status === "completed") live.info.finalResponse = live.candidateResponse;
    else delete live.info.finalResponse;
    if (error !== undefined) live.info.error = formatAgentError(error);
    else delete live.info.error;
    live.info.completedAt = Date.now();
    live.info.lastActivity = Date.now();
    try { saveInfo(live.info); } finally {
      // A failed status save must remain visible, but cannot strand registered waiters.
      this.notifyStatusChange(live.info);
      if (status === "interrupted") this.finishWaitTarget(live.info.parentSessionId, live.info.canonicalName);
      this.pushMailbox({
        id: randomUUID(),
        parentSessionId: live.info.parentSessionId,
        agentName: live.info.canonicalName,
        status,
        ...(status === "completed" ? { finalResponse: live.info.finalResponse } : {}),
        ...(error !== undefined ? { error: live.info.error } : {}),
        createdAt: Date.now(),
      }, status !== "interrupted");
    }
  }

  private removeMailboxEvents(parentSessionId: string, agentName: string): void {
    for (let index = this.mailbox.length - 1; index >= 0; index--) {
      const event = this.mailbox[index];
      if (event.parentSessionId === parentSessionId && event.agentName === agentName) this.mailbox.splice(index, 1);
    }
  }

  private pushMailbox(event: AgentCompletionEvent, notify = true): void {
    this.removeMailboxEvents(event.parentSessionId, event.agentName);
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.parentSessionId === event.parentSessionId && targetMatches(event, waiter.targets));
    if (waiterIndex !== -1) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      waiter.resolve(event);
      return;
    }
    this.mailbox.push(event);
    const matchingClaims = [...this.waitAllClaims].filter((claim) =>
      claim.parentSessionId === event.parentSessionId && claim.targets.has(event.agentName)
    );
    if (notify) {
      for (const claim of matchingClaims) claim.suppressedEventIds.add(event.id);
      if (!matchingClaims.length) this.notifyUnclaimedCompletion(event);
    }
  }

  listAgents(pathPrefix: string | undefined, parentSessionId: string, includeAll = false): AgentListEntry[] {
    const prefix = pathPrefix?.trim().replace(/^\/+/, "");
    const infos = includeAll ? readAllInfos() : readScopeInfos(parentSessionId);
    return infos
      .filter((info) => !prefix || info.taskName.startsWith(prefix))
      .map((info) => ({
        agent_name: info.canonicalName,
        agent_status: info.status,
        last_task_message: previewText(info.lastTaskMessage),
        ...(includeAll ? { parent_session_id: info.parentSessionId } : {}),
      }));
  }

  getAgentInfo(target: string, parentSessionId: string): AgentInfo {
    const info = getAgent(target, parentSessionId);
    if (!info) throw new Error(`Agent not found in this parent session: ${target}`);
    return info;
  }

  readAgentResponse(target: string, parentSessionId: string): AgentResponseEntry {
    return this.agentResponse(this.getAgentInfo(target, parentSessionId));
  }

  private agentResponse(info: AgentInfo): AgentResponseEntry {
    return {
      agent_name: info.canonicalName,
      status: info.status,
      ...(info.finalResponse !== undefined ? { finalResponse: info.finalResponse } : {}),
      ...(info.error ? { error: info.error } : {}),
      last_task_message: previewText(info.lastTaskMessage),
    };
  }

  private waitTargetInfo(info: AgentInfo): AgentInfo {
    const live = this.live.get(info.id);
    if (live) return live.info;
    const event = this.mailbox.find((event) => event.parentSessionId === info.parentSessionId && event.agentName === info.canonicalName);
    return event ? { ...info, status: event.status, finalResponse: event.finalResponse, error: event.error, completedAt: event.createdAt } : info;
  }

  private checkWaitTarget(info: AgentInfo): void {
    if (!FINAL_STATUSES.has(info.status) && !this.live.has(info.id) && !isRunActive(info.id)) {
      throw new Error(`Agent ${info.canonicalName} has no active session but its saved status is ${info.status}. A status save may have failed; inspect the subagent log before retrying.`);
    }
  }

  private finishWaitTarget(parentSessionId: string, agentName: string): void {
    this.defaultWaitAllTargets.get(parentSessionId)?.delete(canonicalAgentName(agentName));
  }

  async waitAgent(parentSessionId: string, targets?: string[], signal?: AbortSignal): Promise<{ message: string; event?: AgentCompletionEvent }> {
    const waitSignal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal;
    throwIfAborted(waitSignal);
    const normalizedTargets = targets?.length ? new Set(targets.map(canonicalAgentName)) : undefined;
    const existing = consumeFirstMatchingMailboxEvent(this.mailbox, parentSessionId, normalizedTargets);
    if (existing) {
      this.finishWaitTarget(parentSessionId, existing.agentName);
      return { message: `Wait completed: ${existing.agentName} ${existing.status}.`, event: existing };
    }
    if (normalizedTargets) {
      const targetInfos = readScopeInfos(parentSessionId).filter((info) => normalizedTargets.has(info.canonicalName)).map((info) => this.waitTargetInfo(info));
      if (!targetInfos.length) throw new Error(`Agent not found in this parent session: ${Array.from(normalizedTargets).join(", ")}`);
      const finalInfo = targetInfos.find((info) => FINAL_STATUSES.has(info.status));
      if (!finalInfo) for (const info of targetInfos) this.checkWaitTarget(info);
      if (finalInfo) {
        this.finishWaitTarget(parentSessionId, finalInfo.canonicalName);
        return {
          message: `Wait completed: ${finalInfo.canonicalName} ${finalInfo.status}.`,
          event: {
            id: randomUUID(),
            parentSessionId,
            agentName: finalInfo.canonicalName,
            status: finalInfo.status,
            finalResponse: finalInfo.finalResponse,
            error: finalInfo.error,
            createdAt: Date.now(),
          },
        };
      }
    }
    return await new Promise((resolve, reject) => {
      let waiter: Waiter;
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        waitSignal.removeEventListener("abort", onAbort);
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        callback();
      };
      const onAbort = () => settle(() => reject(abortError(waitSignal)));
      waiter = {
        parentSessionId,
        targets: normalizedTargets,
        resolve: (event) => settle(() => {
          this.finishWaitTarget(parentSessionId, event.agentName);
          resolve({ message: `Wait completed: ${event.agentName} ${event.status}.`, event });
        }),
      };
      this.waiters.push(waiter);
      waitSignal.addEventListener("abort", onAbort, { once: true });
      if (waitSignal.aborted) onAbort();
    });
  }

  async waitAllAgents(parentSessionId: string, targets?: string[], signal?: AbortSignal): Promise<{ message: string; responses: AgentResponseEntry[] }> {
    const waitSignal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal;
    throwIfAborted(waitSignal);
    const explicitTargets = targets?.length ? new Set(targets.map(canonicalAgentName)) : undefined;
    const defaultTargets = this.defaultWaitAllTargets.get(parentSessionId) ?? new Set<string>();
    const targetSet = explicitTargets ?? new Set(defaultTargets);
    if (explicitTargets) {
      const infos = readScopeInfos(parentSessionId);
      const missing = [...explicitTargets].filter((target) => !infos.some((info) => target === info.canonicalName));
      if (missing.length) throw new Error(`Agent not found in this parent session: ${missing.join(", ")}`);
    }
    const matchingInfos = () => readScopeInfos(parentSessionId).filter((info) => targetSet.has(info.canonicalName)).map((info) => this.waitTargetInfo(info));
    const pendingNames = () => matchingInfos().filter((info) => {
      this.checkWaitTarget(info);
      return !FINAL_STATUSES.has(info.status);
    }).map((info) => info.canonicalName);
    const finalize = () => {
      const responses = matchingInfos().filter((info) => FINAL_STATUSES.has(info.status)).map((info) => this.agentResponse(info));
      for (const response of responses) this.finishWaitTarget(parentSessionId, response.agent_name);
      for (let index = this.mailbox.length - 1; index >= 0; index--) {
        const event = this.mailbox[index];
        if (event.parentSessionId === parentSessionId && targetSet.has(event.agentName)) this.mailbox.splice(index, 1);
      }
      return {
        message: "All target agents reached final status.",
        responses,
      };
    };
    const claim = { parentSessionId, targets: targetSet, suppressedEventIds: new Set<string>() };
    this.waitAllClaims.add(claim);
    try {
      while (true) {
        throwIfAborted(waitSignal);
        if (!pendingNames().length) return finalize();
        await delay(250, undefined, { signal: waitSignal });
      }
    } finally {
      this.waitAllClaims.delete(claim);
      for (const eventId of claim.suppressedEventIds) {
        // Tentative input hides the old event from waits, not from claim cancellation.
        const event = this.mailbox.find((candidate) => candidate.id === eventId)
          ?? [...this.live.values()].find((live) => live.suspendedCompletion?.id === eventId)?.suspendedCompletion;
        if (!event) continue;
        const claimedElsewhere = [...this.waitAllClaims].some((candidate) =>
          candidate.parentSessionId === event.parentSessionId && candidate.targets.has(event.agentName)
        );
        if (!claimedElsewhere) this.notifyUnclaimedCompletion(event);
      }
    }
  }

  async sendMessage(parentSessionId: string, target: string, message: string): Promise<{ delivery: "steer" | "prompt" }> {
    throwIfAborted(this.shutdownController.signal);
    await this.reconciliation;
    throwIfAborted(this.shutdownController.signal);
    let info = this.getAgentInfo(target, parentSessionId);
    let live = this.live.get(info.id);
    while (live?.closing) {
      await this.waitForTermination(live);
      throwIfAborted(this.shutdownController.signal);
      // Cleanup yielded; a competing caller might now own a different live instance.
      info = this.getAgentInfo(target, parentSessionId);
      live = this.live.get(info.id);
    }
    if (live?.awaitingPrompt) throw new Error(`Agent ${info.canonicalName} is still starting. Retry after startup finishes.`);
    if (!live) {
      await this.startLiveAgent(info, message);
      return { delivery: "prompt" };
    }
    const current = live;
    const session = current.session!;
    if (current.finalizedRun || !session.isStreaming) throw new Error(`Agent ${info.canonicalName} is finishing. Retry after cleanup.`);
    const steer = session.steer(message, undefined, { source: "rpc" });
    // An asynchronous input hook can outlive the model run. This is operation tracking, not
    // a message queue: closing rejects new inputs and cleanup waits for the original ones.
    current.pendingSteers.add(steer);
    void steer.then(() => {
      if (this.live.get(info.id) === current && current.cancellation.signal.aborted) {
        // abort() does not retract an input that queues after cancellation. Discard only
        // still-pending native messages; never rewrite messages already in the transcript.
        try { session.clearQueue(); } catch (error) { this.reportError(current, error); }
        this.requestAbort(current);
      }
      current.pendingSteers.delete(steer);
    }, () => current.pendingSteers.delete(steer));
    const timeout = new Error(`Timed out waiting for agent ${info.canonicalName} steering acceptance.`);
    try {
      await boundedWait(steer, DEFAULT_STARTUP_TIMEOUT_MS, timeout, this.shutdownController.signal);
    } catch (error) {
      // A timed-out input is still owned by the SDK. Cancel this run and keep its JSONL
      // locked until pendingSteers exits; ordinary input rejection must not abort the run.
      if (error === timeout && this.live.get(info.id) === current && !current.finalizedRun) {
        this.requestCancellation(current, timeout);
        try { this.markFailed(current, timeout.message); } catch (saveError) { this.reportError(current, saveError); }
        finally { this.scheduleTermination(current); }
      }
      throw error;
    }
    throwIfAborted(this.shutdownController.signal);
    if (this.live.get(info.id) !== current || current.closing || current.finalizedRun || !session.isStreaming) {
      throw new Error(`Agent ${info.canonicalName} ended while steering input was being processed; delivery cannot be confirmed. Retry after cleanup.`);
    }
    current.info.lastTaskMessage = message;
    current.info.lastActivity = Date.now();
    saveInfo(current.info);
    return { delivery: "steer" };
  }

  async interruptAgent(parentSessionId: string, target: string): Promise<{ previous_status: AgentRuntimeStatus }> {
    await this.reconciliation;
    const persisted = this.getAgentInfo(target, parentSessionId);
    const previous = persisted.status;
    const live = this.live.get(persisted.id);
    if (previous !== "starting" && previous !== "running") {
      if (live?.closing) await this.waitForTermination(live);
      return { previous_status: previous };
    }
    if (live) {
      this.requestCancellation(live, new Error("Agent interrupted."));
      let failure: unknown;
      try { this.markInterrupted(live); } catch (error) { failure = error; }
      finally {
        try { await this.waitForTermination(live); } catch (error) {
          this.reportError(live, error);
          failure ??= error;
        }
      }
      if (failure) throw failure;
    } else {
      if (isRunActive(persisted.id)) throw new Error(`Agent ${persisted.canonicalName} is active in another host and cannot be controlled by this manager.`);
      persisted.status = "interrupted";
      persisted.completedAt = Date.now();
      persisted.lastActivity = Date.now();
      delete persisted.finalResponse;
      delete persisted.error;
      saveInfo(persisted);
      this.notifyStatusChange(persisted);
      this.finishWaitTarget(parentSessionId, persisted.canonicalName);
      this.pushMailbox({ id: randomUUID(), parentSessionId, agentName: persisted.canonicalName, status: "interrupted", createdAt: Date.now() }, false);
    }
    return { previous_status: previous };
  }

  private requestCancellation(live: LiveAgent, reason: Error): void {
    live.closing = true;
    this.clearModelResponseTimer(live);
    live.cancellation.abort(reason);
    this.requestAbort(live);
  }

  private requestAbort(live: LiveAgent): void {
    if (!live.session || this.live.get(live.info.id) !== live) return;
    // Never await an SDK run from inside one of its callbacks.
    try { void live.session.abort().catch((error) => this.reportError(live, error)); }
    catch (error) { this.reportError(live, error); }
  }

  private scheduleTermination(live: LiveAgent): void {
    void this.waitForTermination(live).catch((error) => this.reportError(live, error));
  }

  private waitForTermination(live: LiveAgent): Promise<void> {
    return boundedWait(this.terminateSession(live), CLEANUP_WAIT_TIMEOUT_MS,
      `Agent ${live.info.canonicalName} is still closing after ${CLEANUP_WAIT_TIMEOUT_MS} ms; its session file remains locked until actual cleanup completes.`);
  }

  private terminateSession(live: LiveAgent): Promise<void> {
    if (live.termination) return live.termination;
    live.closing = true;
    this.clearModelResponseTimer(live);
    // abort listeners can synchronously request shutdown. Publish the shared promise first.
    live.termination = Promise.resolve().then(async () => {
      this.requestAbort(live);
      // abort()'s idle excludes input/preflight and initialization. Do not dispose, clear the
      // active marker or allow the JSONL to reopen until those ORIGINAL operations return.
      await live.initialization?.catch(() => {});
      await live.promptFinished?.catch(() => {});
      await Promise.allSettled(live.pendingSteers);
      const errors: unknown[] = [];
      try {
        if (live.session) {
          try { await live.session.abort(); } catch (error) { errors.push(error); }
          await live.session.waitForIdle();
          this.sampleContextUsage(live);
          try { await shutdownChildSession(live.session); } catch (error) { errors.push(error); }
        }
      } finally {
        // shutdownChildSession disposes even when its bounded shutdown hook fails.
        // This block is only reached after initialization and submitted input have exited.
        try { live.unsubscribe?.(); } catch (error) { errors.push(error); }
        this.clearModelResponseTimer(live);
        try { live.broadcaster.stop(); } catch (error) { errors.push(error); }
        try { live.logger.close(); } catch (error) { errors.push(error); }
        if (this.live.get(live.info.id) === live) this.live.delete(live.info.id);
      }
      if (errors.length) throw new AggregateError(errors, `Failed to clean up ${live.info.canonicalName}: ${errors.map(formatAgentError).join("; ")}`);
    });
    // Keep tracking late cleanup even after every caller's finite wait has expired.
    void live.termination.catch((error) => this.reportError(live, error));
    return live.termination;
  }

  async shutdown(): Promise<void> {
    this.shutdownController.abort(new Error("Agent manager shut down."));
    const errors: unknown[] = [];
    const terminations = [...this.live.values()].map((live) => {
      this.requestCancellation(live, abortError(this.shutdownController.signal));
      try {
        if (!live.finalizedRun) this.markInterrupted(live);
      } catch (error) { errors.push(error); }
      // One failed save must not skip this child or any sibling's cleanup.
      return this.waitForTermination(live);
    });
    const results = await Promise.allSettled([this.reconciliation, ...terminations]);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    if (errors.length) {
      const error = new AggregateError(errors, `Subagent shutdown failed: ${errors.map(formatAgentError).join("; ")}`);
      this.reportError(undefined, error);
      throw error;
    }
  }
}

export function writeFullToolOutput(content: string): string {
  const directory = path.join(getRunsDir(), "_outputs");
  ensurePrivateDir(directory, true);
  const file = path.join(directory, `${Date.now()}-${randomUUID()}.txt`);
  fs.writeFileSync(file, content);
  return file;
}
