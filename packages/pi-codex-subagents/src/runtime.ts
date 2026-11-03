import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionServices,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";

export interface ChildSessionOptions {
  info: {
    cwd: string;
    sessionFile: string;
    provider: string;
    modelId: string;
    thinking?: AgentSession["thinkingLevel"];
    tools?: string;
    skillPaths?: string[];
    extensionPaths?: string[];
  };
  systemPromptPath: string;
  /** Only pass a parent's effective decision when its cwd is the child's cwd. */
  projectTrusted?: boolean;
  /** Transfers cleanup ownership, including when binding subsequently fails. */
  onCreated: (session: AgentSession) => void;
  checkCanceled: () => void;
  onError: (error: unknown) => void;
  /** Must synchronously register the parent's cancellation/closing request. */
  onShutdown: () => void;
  log: (text: string) => void;
}

function checkDiagnostics(services: AgentSessionServices, log: ChildSessionOptions["log"], logged: Set<string>): void {
  const loader = services.resourceLoader;
  const extensions = loader.getExtensions();
  const diagnostics = [
    ...services.diagnostics,
    ...extensions.errors.map(({ path, error }) => ({ type: "error", message: `${path}: ${error}` })),
    ...(extensions.warnings ?? []).map(({ path, warning }) => ({ type: "warning", message: `${path}: ${warning}` })),
    ...[loader.getSkills(), loader.getPrompts(), loader.getThemes()].flatMap(({ diagnostics }) =>
      diagnostics.map(({ type, path, message }) => ({ type, message: path ? `${path}: ${message}` : message }))),
  ];
  const errors: string[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.type === "error") errors.push(diagnostic.message);
    else {
      const message = `${diagnostic.type}: ${diagnostic.message}`;
      if (!logged.has(message)) {
        logged.add(message);
        log(message);
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

/** Assemble one independent SDK session. The caller owns all lifecycle tracking and cleanup. */
export async function createChildSession(options: ChildSessionOptions): Promise<AgentSession> {
  const { info, checkCanceled } = options;
  checkCanceled();
  const cwd = resolve(info.cwd);
  const systemPromptPath = resolve(options.systemPromptPath);
  // Validate the file, but give the loader its ORIGINAL path, not its text-or-path contents.
  const systemPrompt = await readFile(systemPromptPath, "utf8");
  checkCanceled();
  if (!systemPrompt.replace(/^\uFEFF/, "").trim()) throw new Error(`System prompt is empty: ${systemPromptPath}`);

  const agentDir = getAgentDir();
  // SDK 1.4.0 defaults projectTrusted to true. Start closed before reading project settings.
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  // Public native trust-store/settings primitives implement Pi's headless fallback without
  // importing its private CLI resolver, prompting, or persisting a new trust decision.
  const projectTrusted = options.projectTrusted
    ?? new ProjectTrustStore(agentDir).get(cwd)
    ?? (!hasTrustRequiringProjectResources(cwd) || settingsManager.getDefaultProjectTrust() === "always");
  settingsManager.setProjectTrusted(projectTrusted);

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: {
      noContextFiles: true,
      noSkills: true,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: systemPromptPath,
      appendSystemPrompt: [],
      additionalSkillPaths: info.skillPaths,
      additionalExtensionPaths: info.extensionPaths,
    },
  });
  checkCanceled();
  const loggedDiagnostics = new Set<string>();
  checkDiagnostics(services, options.log, loggedDiagnostics);
  if (!services.resourceLoader.getSystemPrompt()?.trim()) throw new Error(`System prompt is empty: ${systemPromptPath}`);

  const available = await services.modelRuntime.getAvailable(info.provider);
  checkCanceled();
  const model = available.find((model) => model.provider === info.provider && model.id === info.modelId);
  if (!model) throw new Error(`Model is not available: ${info.provider}/${info.modelId}`);

  const tools = info.tools?.split(",").map((name) => name.trim()).filter(Boolean);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.open(info.sessionFile, dirname(info.sessionFile), cwd),
    model,
    thinkingLevel: info.thinking,
    ...(tools === undefined ? {} : tools.length ? { tools } : { noTools: "builtin" as const }),
  });
  // Do not check cancellation or await binding before the parent can track this object.
  options.onCreated(session);
  checkCanceled();
  // Native binding reports hook/provider errors via onError instead of rejecting. Do not
  // silently accept a surviving same-name model after a failed startup registration.
  const bindingErrors: string[] = [];
  let binding = true;
  try {
    await session.bindExtensions({
      mode: "print",
      onError(error) {
        if (binding) bindingErrors.push(`Extension "${error.extensionPath}" error: ${error.event}: ${error.error}`);
        options.onError(error);
      },
      shutdownHandler: options.onShutdown,
    });
  } finally {
    binding = false;
  }
  checkCanceled();
  if (bindingErrors.length) throw new Error(bindingErrors.join("\n"));
  // resources_discover runs during binding and can add diagnostics after services creation.
  checkDiagnostics(services, options.log, loggedDiagnostics);

  const stillAvailable = await session.modelRuntime.getAvailable(info.provider);
  checkCanceled();
  if (!stillAvailable.some((model) => model.provider === info.provider && model.id === info.modelId)) {
    throw new Error(`Model is not available after extension binding: ${info.provider}/${info.modelId}`);
  }
  if (session.model?.provider !== info.provider || session.model.id !== info.modelId) {
    throw new Error(`Extensions changed the selected model: expected ${info.provider}/${info.modelId}, got ${session.model?.provider}/${session.model?.id}`);
  }
  return session;
}

/**
 * Pi 1.4.0's RPC acceptance hook is exported but marked internal. Keep the version-sensitive
 * call here; the caller tracks this ORIGINAL promise and chains waitForIdle() for completion.
 */
export function promptChildSession(
  session: AgentSession,
  message: string,
  preflightResult: NonNullable<PromptOptions["preflightResult"]>,
): Promise<void> {
  return session.prompt(message, { source: "rpc", preflightResult });
}

/**
 * Call once, only after initialization and submitted input/runs have exited and native idle
 * has been reached. This bounds extension shutdown, not cooperative abort or preflight.
 */
export async function shutdownChildSession(session: AgentSession, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Child session_shutdown timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    session.dispose();
  }
}
