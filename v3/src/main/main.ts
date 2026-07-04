import { app, BrowserWindow, desktopCapturer, ipcMain, Notification, screen, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openLocalApp } from "./appLauncher.js";
import {
  extractAssistantText,
  extractLastAssistantText,
  extractPiError,
  isUnsupportedToolModelError,
  sanitizeAssistantText
} from "./assistantText.js";
import { readConfig, writeConfig } from "./config.js";
import { generateWithOllama, analyzeImageWithOllama, resolveActiveModel } from "./ollamaClient.js";
import { ensureOllamaReady } from "./ollamaRuntime.js";
import { PythonWorkerBridge } from "./pythonWorker.js";
import { PiRpcBridge } from "./piRpc.js";
import { McpManager } from "./mcpManager.js";
import { routeUserIntent } from "./intentRouter.js";
import {
  extractUserLocation,
  isOpenAppFailure,
  openAppFailureMessage,
  resolveContextualLocalTool,
  resolveDirectLocalTool,
  runNamedLocalTool,
  type LocalToolArgs,
  type LocalToolName,
  type LocalToolServices
} from "./localTools.js";
import { normalizeVoiceTranscript, tryParseTextualToolCall, tryRecoverOpenedClaim, garbledTranscriptHint } from "./voiceTranscript.js";
import { EchoBridge, type EchoBridgeEvent, type EchoPromptReply } from "./echoBridge.js";
import { UserMemoryStore } from "./userMemory.js";
import { isRetryPrompt } from "./toolRetry.js";
import { compactDebugDetails, createLogger, formatDebugFields, truncateDebugValue } from "./logger.js";
import type { McpStatus, ModelStats, WorkerEvent } from "../shared/types.js";
const dirname = path.dirname(fileURLToPath(import.meta.url));
const debug = createLogger("main");
let config = readConfig();
const pythonWorker = new PythonWorkerBridge();
const pi = new PiRpcBridge(config.pi);
const mcp = new McpManager(config.mcp);
const echoBridge = new EchoBridge({
  onPrompt: handleEchoPrompt,
  onEvent: handleEchoBridgeEvent
});
const userMemory = new UserMemoryStore();
const pendingPiPrompts = new Map<string, NodeJS.Timeout>();
let piHadAnswerForCurrentTurn = false;
let activePrompt: string | null = null;
let activeTurnId = 0;
let knownLocation: string | null = "Eagan, Minnesota";
let lastRetryableTool: { name: LocalToolName; args: LocalToolArgs; knownLocation: string | null } | null = null;
const conversationHistory: Array<{ role: "user" | "assistant"; text: string }> = [];
let wakewordArmed = false;
let isQuitting = false;

let mainWindow: BrowserWindow | null = null;

type PromptSource = "typed" | "echo" | "retry" | "fallback" | "gemma";
type ToolEventPayload = {
  name: string;
  text?: string;
  location?: string;
  query?: string;
  url?: string;
  error?: string;
  args?: LocalToolArgs;
  route?: string;
  source?: PromptSource;
  turnId?: number;
  durationMs?: number;
};

const localToolServices: LocalToolServices = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timeout) => clearTimeout(timeout),
  userMemory,
  spotify: config.spotify,
  captureScreen,
  analyzeScreen: (imagePath, prompt) => analyzeImageWithOllama(imagePath, prompt, config),
  openApp: openLocalApp,
  openWebsite: (url) => shell.openExternal(url),
  onAlarm: (alarm) => {
    const text = `Alarm: ${alarm.label}`;
    debug(`alarm fired id=${alarm.id} label="${alarm.label}"`);
    broadcastAssistantText(text, "alarm");
    pythonWorker.send({ type: "speak", text });
    if (Notification.isSupported()) {
      new Notification({ title: "Pythos alarm", body: alarm.label }).show();
    }
  }
};

function broadcastModelStats(stats: ModelStats): void {
  debug(
    `model stats model=${stats.model} tok/s=${stats.tokensPerSecond} ttft=${stats.ttftSeconds}s ` +
      `tokens=${stats.evalCount} thinking=${stats.thinking}${stats.thinkReason ? ` (${stats.thinkReason})` : ""}`
  );
  broadcast("model:stats", stats);
}

function broadcast(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  try {
    mainWindow.webContents.send(channel, payload);
  } catch {
    mainWindow = null;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    title: "Pythos v3",
    backgroundColor: "#090b10",
    webPreferences: {
      preload: path.join(dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (!app.isPackaged) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

mcp.on("status", (status: McpStatus) => {
  if (!isQuitting) {
    broadcast("mcp:status", status);
    emitDebugEvent("mcp status", {
      enabled: status.enabled,
      servers: status.servers.map((server) => `${server.name}:${server.connected ? server.toolCount : "off"}`).join(",")
    });
  }
});

app.whenReady().then(() => {
  debug("app ready");
  createWindow();
  pythonWorker.start();
  echoBridge.start();
  void mcp.init().catch((error) => debug(`mcp init failed ${String(error)}`));
  void ensureOllamaReady(config).then((result) => {
    debug(`ollama ensure ready=${result.ready} model=${result.model} msg=${result.message}`);
    broadcast("ollama:status", result);
    if (!result.ready) {
      broadcast("pi:event", {
        type: "status",
        payload: { type: "status", text: result.message }
      });
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  debug("window-all-closed");
  isQuitting = true;
  wakewordArmed = false;
  clearPendingPiFallbacks();
  pythonWorker.stop();
  echoBridge.stop();
  pi.stop();
  void mcp.shutdown();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function handleEchoBridgeEvent(event: EchoBridgeEvent): void {
  if (event.type === "listening") {
    debug(`echo bridge listening ws=${event.payload.wsUrl} upload=${event.payload.uploadUrl}`);
  }
  if (event.type === "transcript") {
    broadcast("worker:event", {
      type: "final_transcript",
      payload: { text: event.payload.text }
    } satisfies WorkerEvent);
  }
  if (event.type === "error") {
    broadcast("assistant:state", "error");
  }
  broadcast("pi:event", {
    type: "echo",
    payload: event
  });
}

pythonWorker.on("event", (event: WorkerEvent) => {
  if (isQuitting) {
    return;
  }
  if (event.type !== "audio_level") {
    debug(`worker event ${JSON.stringify(event)}`);
  }
  broadcast("worker:event", event);
  if (event.type === "final_transcript") {
    broadcast("assistant:state", "thinking");
    handleUserPrompt(event.payload.text);
  }
  if (event.type === "tts_done" && wakewordArmed) {
    pythonWorker.send({ type: "start_wakeword" });
  }
});

pi.on("event", (event) => {
  if (isQuitting) {
    return;
  }
  if (event.type === "exit") {
    if (pendingPiPrompts.size > 0) {
      broadcast("pi:event", event);
      void respondWithFallback(activePrompt, "Pi exited while handling the request. Using local Gemma.");
    } else {
      broadcast("assistant:state", "idle");
    }
    return;
  }
  if ((event.type === "error" || event.type === "unavailable") && pendingPiPrompts.size > 0) {
    broadcast("pi:event", event);
    void respondWithFallback(activePrompt, "Pi failed while handling the request. Using local Gemma.");
    return;
  }
  if (event.type !== "stderr") {
    broadcast("pi:event", event);
  }
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload?.type === "agent_start") {
    piHadAnswerForCurrentTurn = false;
    broadcast("assistant:state", "thinking");
  }
  const piError = extractPiError(payload);
  if (piError) {
    clearPendingPiFallbacks();
    if (isUnsupportedToolModelError(piError)) {
      void respondWithFallback(
        activePrompt,
        "Pi tool model unavailable. Using local Gemma."
      );
      return;
    }
    broadcast("assistant:state", "idle");
  }
  if (payload?.type === "agent_end") {
    pi.getLastAssistantText();
  }
  if (payload?.type === "response" && payload.command === "get_last_assistant_text") {
    const text = sanitizeAssistantText(extractLastAssistantText(payload));
    if (text) {
      clearPendingPiFallbacks();
      piHadAnswerForCurrentTurn = true;
      broadcastAssistantText(text, "pi");
      pythonWorker.send({ type: "speak", text });
    } else if (!piHadAnswerForCurrentTurn) {
      broadcast("assistant:state", "idle");
    }
  }
  if (payload?.type === "message_update") {
    broadcast("assistant:state", "thinking");
  }
  if (payload?.type === "message_end") {
    clearPendingPiFallbacks();
    const text = sanitizeAssistantText(extractAssistantText(payload));
    if (text) {
      pythonWorker.send({ type: "speak", text });
    } else if (!activePrompt) {
      broadcast("assistant:state", "idle");
    }
  }
});

pi.on("status", (status) => {
  if (!isQuitting) {
    broadcast("pi:status", status);
  }
});

ipcMain.handle("worker:startListening", () => {
  debug("IPC worker:startListening");
  wakewordArmed = false;
  pythonWorker.send({ type: "start_listening" });
});
ipcMain.handle("worker:startWakeword", () => {
  debug("IPC worker:startWakeword");
  wakewordArmed = true;
  pythonWorker.send({ type: "start_wakeword" });
});
ipcMain.handle("worker:stopListening", () => {
  debug("IPC worker:stopListening");
  wakewordArmed = false;
  pythonWorker.send({ type: "stop_listening" });
});
ipcMain.handle("worker:speak", (_event, text: string, lengthScale?: number) =>
  {
    debug(`IPC worker:speak chars=${text.length}`);
    pythonWorker.send({ type: "speak", text, lengthScale });
  }
);
ipcMain.handle("worker:stopSpeaking", () => {
  debug("IPC worker:stopSpeaking");
  pythonWorker.send({ type: "stop_speaking" });
});
ipcMain.handle("pi:prompt", (_event, message: string) => pi.prompt(message));
ipcMain.handle("pi:abort", () => pi.abort());
ipcMain.handle("pi:getCommands", () => pi.getCommands());
ipcMain.handle("pi:getStatus", () => pi.getStatus());
ipcMain.handle("mcp:getStatus", () => mcp.getStatus());
ipcMain.handle("assistant:prompt", (_event, prompt: string) => {
  const clean = String(prompt ?? "").trim();
  if (!clean) {
    return false;
  }
  debug(`IPC assistant:prompt chars=${clean.length}`);
  broadcast("assistant:state", "thinking");
  void handleUserPrompt(clean);
  return true;
});
ipcMain.handle("assistant:clearContext", () => {
  debug("IPC assistant:clearContext");
  conversationHistory.length = 0;
  activePrompt = null;
  return true;
});
ipcMain.handle("app:getConfig", () => config);
ipcMain.handle("app:saveConfig", (_event, nextConfig) => {
  config = writeConfig(nextConfig);
  localToolServices.spotify = config.spotify;
  pi.updateConfig(config.pi);
  void mcp.updateConfig(config.mcp).catch((error) => debug(`mcp reload failed ${String(error)}`));
  pythonWorker.restart();
  broadcast("assistant:state", "idle");
  return config;
});

async function handleUserPrompt(rawPrompt: string): Promise<void> {
  const prompt = normalizeVoiceTranscript(String(rawPrompt ?? "").trim());
  if (!prompt) {
    return;
  }
  const turnId = activeTurnId + 1;
  activeTurnId = turnId;
  broadcast("assistant:state", "thinking");
  pythonWorker.send({ type: "stop_speaking" });
  activePrompt = prompt;
  rememberTurn("user", prompt);
  emitDebugEvent("turn received", { turnId, source: "typed", prompt });
  const nextLocation = extractUserLocation(prompt);
  if (nextLocation) {
    knownLocation = nextLocation;
    debug(`known location updated location="${knownLocation}"`);
    emitDebugEvent("known location updated", { turnId, source: "typed", location: knownLocation });
  }

  if (isRetryPrompt(prompt) && lastRetryableTool) {
    emitDebugEvent("route retry", {
      turnId,
      source: "typed",
      tool: lastRetryableTool.name,
      args: lastRetryableTool.args
    });
    await retryLastTool(turnId, "gemma");
    return;
  }

  const garbledHint = garbledTranscriptHint(prompt);
  if (garbledHint) {
    emitDebugEvent("route garbled transcript", { turnId, source: "typed", prompt });
    activePrompt = null;
    rememberTurn("assistant", garbledHint);
    broadcastAssistantText(garbledHint, "clarify");
    pythonWorker.send({ type: "speak", text: garbledHint });
    return;
  }

  const directToolText = await runDirectLocalTool(prompt, { turnId, source: "typed" });
  if (directToolText !== null) {
    if (turnId !== activeTurnId) {
      debug(`direct tool response ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
      emitDebugEvent("stale direct tool response ignored", { turnId, activeTurnId, source: "typed" });
      return;
    }
    activePrompt = null;
    rememberTurn("assistant", directToolText);
    broadcastAssistantText(directToolText, "local-tool");
    pythonWorker.send({ type: "speak", text: directToolText });
    return;
  }

  await respondDirect(prompt, turnId);
}

async function handleEchoPrompt(context: { transcript: string; deviceId: string; sessionId: string }): Promise<EchoPromptReply> {
  const prompt = normalizeVoiceTranscript(context.transcript.trim());
  const turnId = activeTurnId + 1;
  let toolUsed = false;
  activeTurnId = turnId;
  broadcast("assistant:state", "thinking");
  pythonWorker.send({ type: "stop_speaking" });
  echoBridge.setLed("active-thinking");
  activePrompt = prompt;
  rememberTurn("user", prompt);
  emitDebugEvent("turn received", {
    turnId,
    source: "echo",
    deviceId: context.deviceId,
    sessionId: context.sessionId,
    prompt
  });

  const nextLocation = extractUserLocation(prompt);
  if (nextLocation) {
    knownLocation = nextLocation;
    debug(`known location updated from echo location="${knownLocation}"`);
    emitDebugEvent("known location updated", { turnId, source: "echo", location: knownLocation });
  }

  if (isRetryPrompt(prompt) && lastRetryableTool) {
    emitDebugEvent("route retry", {
      turnId,
      source: "echo",
      tool: lastRetryableTool.name,
      args: lastRetryableTool.args
    });
    return { text: await retryLastTool(turnId, "echo"), toolUsed: true };
  }

  const directToolText = await runDirectLocalTool(prompt, { turnId, source: "echo" });
  if (directToolText !== null) {
    if (turnId !== activeTurnId) {
      debug(`echo direct tool response ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
      emitDebugEvent("stale direct tool response ignored", { turnId, activeTurnId, source: "echo" });
      return "I already moved on to another request.";
    }
    activePrompt = null;
    rememberTurn("assistant", directToolText);
    broadcastAssistantText(directToolText, "echo");
    broadcast("assistant:state", "speaking");
    setTimeout(() => {
      if (activeTurnId === turnId) {
        broadcast("assistant:state", "idle");
      }
    }, 5000);
    return { text: directToolText, toolUsed: true };
  }

  try {
    debug(`echo gemma response starting device=${context.deviceId} promptChars=${prompt.length}`);
    const routing = routeUserIntent(prompt, { knownLocation });
    emitDebugEvent("gemma request", {
      turnId,
      source: "echo",
      model: resolveActiveModel(config),
      promptChars: prompt.length,
      difficulty: routing.difficulty,
      llmToolScope: routing.llmToolScope
    });
    const text = sanitizeAssistantText(
      await generateWithOllama(prompt, config, {
        history: getRecentHistory(),
        knownLocation,
        userMemory: userMemory.summary(),
        localToolServices,
        mcp,
        toolScope: routing.llmToolScope,
        onToolEvent: (phase, result) => {
          if (phase === "start") {
            toolUsed = true;
          }
          broadcastLocalToolEvent(phase, { ...result, route: "gemma", source: "echo", turnId });
        },
        onModelStats: broadcastModelStats
      })
    );
    if (turnId !== activeTurnId) {
      debug(`echo response ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
      return { text: "I already moved on to another request.", toolUsed };
    }
    activePrompt = null;
    emitDebugEvent("gemma response", { turnId, source: "echo", chars: text.length, toolUsed });
    const recovered = await tryExecuteTextualToolResponse(text, { turnId, source: "echo", prompt });
    const reply = recovered ?? text;
    if (recovered) {
      toolUsed = true;
    }
    rememberTurn("assistant", reply);
    broadcastAssistantText(reply, recovered ? "local-tool-recovered" : "echo");
    broadcast("assistant:state", "speaking");
    setTimeout(() => {
      if (activeTurnId === turnId) {
        broadcast("assistant:state", "idle");
      }
    }, 5000);
    return { text: reply, toolUsed };
  } catch (error) {
    const message = `I could not reach the local Gemma model. Make sure Ollama is running and '${resolveActiveModel(config)}' is pulled, then try again. ${String(error)}`;
    debug(`echo gemma response failed ${String(error)}`);
    emitDebugEvent("gemma failed", { turnId, source: "echo", error: String(error) });
    activePrompt = null;
    rememberTurn("assistant", message);
    broadcastAssistantText(message, "error");
    broadcast("assistant:state", "error");
    return { text: message, toolUsed };
  }
}

function isStaleTurn(turnId: number): boolean {
  return turnId !== activeTurnId;
}

async function tryExecuteTextualToolResponse(
  text: string,
  context: { turnId: number; source: PromptSource; prompt?: string }
): Promise<string | null> {
  const invocation =
    tryParseTextualToolCall(text) ??
    (context.prompt ? tryRecoverOpenedClaim(text, context.prompt) : null);
  if (!invocation) {
    return null;
  }
  const startedAt = Date.now();
  broadcastLocalToolEvent("start", {
    name: invocation.name,
    text: "Tool started",
    args: invocation.args,
    route: "textual-recovery",
    source: context.source,
    turnId: context.turnId
  });
  try {
    const result = await runNamedLocalTool(invocation.name, invocation.args, knownLocation, localToolServices);
    if (isOpenAppFailure(result)) {
      const message = openAppFailureMessage(result);
      broadcastLocalToolEvent("error", {
        ...result,
        error: message,
        args: invocation.args,
        route: "textual-recovery",
        source: context.source,
        turnId: context.turnId,
        durationMs: Date.now() - startedAt
      });
      return message;
    }
    broadcastLocalToolEvent("end", {
      ...result,
      args: invocation.args,
      route: "textual-recovery",
      source: context.source,
      turnId: context.turnId,
      durationMs: Date.now() - startedAt
    });
    return result.text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    broadcastLocalToolEvent("error", {
      name: invocation.name,
      error: message,
      args: invocation.args,
      route: "textual-recovery",
      source: context.source,
      turnId: context.turnId,
      durationMs: Date.now() - startedAt
    });
    return message;
  }
}

async function runDirectLocalTool(prompt: string, context: { turnId: number; source: PromptSource }): Promise<string | null> {
  const routing = routeUserIntent(prompt, {
    previousToolName: lastRetryableTool?.name ?? null,
    knownLocation
  });
  const directInvocation = resolveDirectLocalTool(prompt, {
    previousToolName: lastRetryableTool?.name ?? null,
    knownLocation
  });
  const contextualInvocation = resolveContextualLocalTool(
    prompt,
    lastRetryableTool?.name ?? null,
    knownLocation
  );
  const invocation = directInvocation ?? contextualInvocation;
  const route = directInvocation ? "direct" : contextualInvocation ? "contextual-direct" : "direct";
  if (!invocation) {
    emitDebugEvent("route gemma", {
      turnId: context.turnId,
      source: context.source,
      previousTool: lastRetryableTool?.name,
      difficulty: routing.difficulty,
      llmToolScope: routing.llmToolScope,
      reason: routing.reason
    });
    return null;
  }

  debug(`direct local tool match name=${invocation.name} args=${JSON.stringify(invocation.args)}`);
  emitDebugEvent("route direct tool", {
    turnId: context.turnId,
    source: context.source,
    route,
    previousTool: lastRetryableTool?.name,
    tool: invocation.name,
    args: invocation.args
  });
  const startedAt = Date.now();
  broadcastLocalToolEvent("start", {
    name: invocation.name,
    text: "Tool started",
    args: invocation.args,
    route,
    source: context.source,
    turnId: context.turnId
  });
  try {
    const result = await runNamedLocalTool(invocation.name, invocation.args, knownLocation, localToolServices);
    if (isOpenAppFailure(result)) {
      const message = openAppFailureMessage(result);
      debug(`direct local tool failed name=${invocation.name} error=${message}`);
      broadcastLocalToolEvent("error", {
        ...result,
        error: message,
        args: invocation.args,
        route,
        source: context.source,
        turnId: context.turnId,
        durationMs: Date.now() - startedAt
      });
      return message;
    }
    broadcastLocalToolEvent("end", {
      ...result,
      args: invocation.args,
      route,
      source: context.source,
      turnId: context.turnId,
      durationMs: Date.now() - startedAt
    });
    return result.text;
  } catch (error) {
    const message = formatDirectToolFailure(invocation.name, error);
    debug(`direct local tool failed name=${invocation.name} error=${String(error)}`);
    broadcastLocalToolEvent("error", {
      name: invocation.name,
      error: message,
      args: invocation.args,
      route,
      source: context.source,
      turnId: context.turnId,
      durationMs: Date.now() - startedAt
    });
    return message;
  }
}

function staleTurnMessage(): string {
  return "I already moved on to another request.";
}

function scheduleEchoIdle(turnId: number, delayMs = 5000): void {
  broadcast("assistant:state", "speaking");
  setTimeout(() => {
    if (activeTurnId === turnId) {
      broadcast("assistant:state", "idle");
    }
  }, delayMs);
}

function finishAssistantTurn(text: string, source: string, _turnId: number, options: { speak?: boolean } = {}): void {
  activePrompt = null;
  rememberTurn("assistant", text);
  broadcastAssistantText(text, source);
  if (options.speak !== false && source !== "error") {
    pythonWorker.send({ type: "speak", text });
  }
}

function gemmaUnavailableMessage(error: unknown, includePi = false): string {
  const prefix = includePi
    ? "I could not reach Pi or the local Gemma model."
    : "I could not reach the local Gemma model.";
  return `${prefix} Make sure Ollama is running and '${resolveActiveModel(config)}' is pulled, then try again. ${String(error)}`;
}

async function retryLastTool(turnId: number, source: PromptSource): Promise<string> {
  const text = await runStoredToolRetry();
  if (isStaleTurn(turnId)) {
    debug(`retry result ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
    return source === "echo" ? staleTurnMessage() : text;
  }
  finishAssistantTurn(text, source === "echo" ? "echo" : "gemma", turnId);
  if (source === "echo") {
    scheduleEchoIdle(turnId);
  }
  return text;
}

async function runStoredToolRetry(): Promise<string> {
  if (!lastRetryableTool) {
    return "I do not have a previous tool action to retry.";
  }
  const invocation = lastRetryableTool;
  const startedAt = Date.now();
  try {
    debug(`retrying tool name=${invocation.name} args=${JSON.stringify(invocation.args)}`);
    broadcastLocalToolEvent("start", {
      name: invocation.name,
      text: "Retrying tool",
      args: invocation.args,
      route: "retry",
      source: "retry"
    });
    const result = await runNamedLocalTool(
      invocation.name,
      invocation.args,
      invocation.knownLocation,
      localToolServices
    );
    if (isOpenAppFailure(result)) {
      const message = openAppFailureMessage(result);
      broadcastLocalToolEvent("error", {
        ...result,
        error: message,
        args: invocation.args,
        route: "retry",
        source: "retry",
        durationMs: Date.now() - startedAt
      });
      return message;
    }
    broadcastLocalToolEvent("end", {
      ...result,
      args: invocation.args,
      route: "retry",
      source: "retry",
      durationMs: Date.now() - startedAt
    });
    return result.text;
  } catch (error) {
    const message = error instanceof Error ? error.message : `Retry failed: ${String(error)}`;
    debug(`retry tool failed name=${invocation.name} error=${String(error)}`);
    broadcastLocalToolEvent("error", {
      name: invocation.name,
      error: message,
      args: invocation.args,
      route: "retry",
      source: "retry",
      durationMs: Date.now() - startedAt
    });
    return message;
  }
}

async function respondDirect(prompt: string, turnId = activeTurnId): Promise<void> {
  clearPendingPiFallbacks();
  try {
    debug(`gemma response starting promptChars=${prompt.length}`);
    const routing = routeUserIntent(prompt, { knownLocation });
    emitDebugEvent("gemma request", {
      turnId,
      source: "typed",
      model: resolveActiveModel(config),
      promptChars: prompt.length,
      difficulty: routing.difficulty,
      llmToolScope: routing.llmToolScope
    });
    broadcast("assistant:state", "thinking");
    const text = sanitizeAssistantText(
      await generateWithOllama(prompt, config, {
        history: getRecentHistory(),
        knownLocation,
        userMemory: userMemory.summary(),
        localToolServices,
        mcp,
        toolScope: routing.llmToolScope,
        onToolEvent: (phase, result) =>
          broadcastLocalToolEvent(phase, { ...result, route: "gemma", source: "typed", turnId }),
        onModelStats: broadcastModelStats
      })
    );
    if (isStaleTurn(turnId)) {
      debug(`gemma response ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
      emitDebugEvent("stale gemma response ignored", { turnId, activeTurnId, source: "typed" });
      return;
    }
    debug(`gemma response complete chars=${text.length}`);
    emitDebugEvent("gemma response", { turnId, source: "typed", chars: text.length });
    const recovered = await tryExecuteTextualToolResponse(text, { turnId, source: "typed", prompt });
    finishAssistantTurn(recovered ?? text, recovered ? "local-tool-recovered" : "gemma", turnId);
  } catch (error) {
    if (isStaleTurn(turnId)) {
      debug(`gemma error ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
      emitDebugEvent("stale gemma error ignored", { turnId, activeTurnId, source: "typed" });
      return;
    }
    debug(`gemma response failed ${String(error)}`);
    emitDebugEvent("gemma failed", { turnId, source: "typed", error: String(error) });
    const message = gemmaUnavailableMessage(error);
    finishAssistantTurn(message, "error", turnId, { speak: false });
    broadcast("assistant:state", "error");
  }
}

async function respondWithFallback(prompt: string | null, reason: string): Promise<void> {
  clearPendingPiFallbacks();
  if (!prompt) {
    emitDebugEvent("fallback skipped", { source: "fallback", reason });
    broadcast("pi:event", {
      type: "fallback",
      payload: { type: "status", text: reason }
    });
    broadcast("assistant:state", "idle");
    return;
  }

  try {
    debug(`gemma response starting reason="${reason}" promptChars=${prompt.length}`);
    const routing = routeUserIntent(prompt, { knownLocation });
    emitDebugEvent("gemma fallback request", {
      source: "fallback",
      model: resolveActiveModel(config),
      promptChars: prompt.length,
      reason,
      difficulty: routing.difficulty,
      llmToolScope: routing.llmToolScope
    });
    broadcast("assistant:state", "thinking");
    broadcast("pi:event", {
      type: "fallback",
      payload: { type: "status", text: reason }
    });
    const text = sanitizeAssistantText(
      await generateWithOllama(prompt, config, {
        history: getRecentHistory(),
        knownLocation,
        userMemory: userMemory.summary(),
        localToolServices,
        mcp,
        toolScope: routing.llmToolScope,
        onToolEvent: (phase, result) => broadcastLocalToolEvent(phase, { ...result, route: "fallback", source: "fallback" }),
        onModelStats: broadcastModelStats
      })
    );
    debug(`gemma response complete chars=${text.length}`);
    emitDebugEvent("gemma fallback response", { source: "fallback", chars: text.length });
    finishAssistantTurn(text, "gemma-fallback", activeTurnId);
  } catch (error) {
    debug(`gemma response failed ${String(error)}`);
    emitDebugEvent("gemma fallback failed", { source: "fallback", error: String(error) });
    finishAssistantTurn(gemmaUnavailableMessage(error, true), "error", activeTurnId, { speak: false });
    broadcast("assistant:state", "error");
  }
}

function rememberTurn(role: "user" | "assistant", text: string): void {
  const clean = sanitizeAssistantText(text);
  if (!clean) {
    return;
  }
  conversationHistory.push({ role, text: clean });
  while (conversationHistory.length > 12) {
    conversationHistory.shift();
  }
}

function getRecentHistory(): Array<{ role: "user" | "assistant"; text: string }> {
  return conversationHistory.slice(-10);
}

function broadcastLocalToolEvent(
  phase: "start" | "end" | "error",
  result: ToolEventPayload
): void {
  debug(`local tool ${phase} ${formatDebugFields({
    name: result.name,
    route: result.route,
    source: result.source,
    turnId: result.turnId,
    durationMs: result.durationMs,
    args: result.args,
    location: result.location,
    query: result.query,
    url: result.url,
    text: result.text,
    error: result.error
  })}`);
  if (phase === "start" && isRetryableToolName(result.name) && result.args) {
    lastRetryableTool = {
      name: result.name,
      args: structuredClone(result.args),
      knownLocation
    };
  }
  const payloadType =
    phase === "start" ? "tool_execution_start" : phase === "error" ? "tool_execution_error" : "tool_execution_end";
  broadcast("pi:event", {
    type: phase === "error" ? "local-tool-error" : "local-tool",
    payload: {
      type: payloadType,
      name: result.name,
      route: result.route,
      source: result.source,
      turnId: result.turnId,
      durationMs: result.durationMs,
      location: result.location,
      query: result.query,
      url: result.url,
      args: result.args,
      text: result.text,
      errorMessage: result.error,
      timestamp: new Date().toISOString()
    }
  });
  if (phase === "end" && activePrompt) {
    broadcast("assistant:state", "thinking");
  }
}

function isRetryableToolName(name: string): name is LocalToolName {
  return [
    "weather",
    "time",
    "calculator",
    "skill_script",
    "alarm",
    "open_app",
    "open_website",
    "web_search",
    "screen",
    "memory",
    "spotify"
  ].includes(name);
}

function broadcastAssistantText(text: string, source: string): void {
  const safeText = sanitizeAssistantText(text);
  broadcast("pi:event", {
    type: source,
    payload: { type: "message_end", text: safeText, source }
  });
}

async function captureScreen(): Promise<{ path: string; width: number; height: number }> {
  const targetDisplay =
    mainWindow && !mainWindow.isDestroyed()
      ? screen.getDisplayMatching(mainWindow.getBounds())
      : screen.getPrimaryDisplay();
  const scale = targetDisplay.scaleFactor;
  const thumbnailSize = {
    width: Math.min(2560, Math.max(640, Math.round(targetDisplay.size.width * scale))),
    height: Math.min(1440, Math.max(480, Math.round(targetDisplay.size.height * scale)))
  };
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize,
    fetchWindowIcons: false
  });
  const displayId = String(targetDisplay.id);
  const source =
    sources.find((entry) => String(entry.display_id) === displayId && !entry.thumbnail.isEmpty()) ??
    sources.find((entry) => !entry.thumbnail.isEmpty());
  if (!source) {
    const permissionHint =
      process.platform === "darwin"
        ? " Grant Screen Recording permission in System Settings > Privacy & Security."
        : "";
    throw new Error(`No screen source was available to capture.${permissionHint}`);
  }
  const image = source.thumbnail;
  const size = image.getSize();
  const filePath = path.join(app.getPath("temp"), `pythos-screen-${Date.now()}.png`);
  fs.writeFileSync(filePath, image.toPNG());
  return { path: filePath, width: size.width, height: size.height };
}

function clearPendingPiFallbacks(): void {
  for (const timer of pendingPiPrompts.values()) {
    clearTimeout(timer);
  }
  pendingPiPrompts.clear();
}

function formatDirectToolFailure(name: LocalToolName, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (name === "open_app") {
    return detail || "I couldn't open that app.";
  }
  return `Tool failed: ${detail}`;
}

function emitDebugEvent(text: string, details: Record<string, unknown> = {}): void {
  debug(`${text} ${formatDebugFields(details)}`.trim());
  broadcast("pi:event", {
    type: "debug",
    payload: {
      type: "debug",
      text,
      timestamp: new Date().toISOString(),
      ...compactDebugDetails(details)
    }
  });
}
