import { app, BrowserWindow, desktopCapturer, ipcMain, Notification, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, writeConfig } from "./config.js";
import { generateWithGemini, resolveGeminiApiKey } from "./geminiClient.js";
import { PythonWorkerBridge } from "./pythonWorker.js";
import { PiRpcBridge } from "./piRpc.js";
import { McpManager } from "./mcpManager.js";
import {
  extractUserLocation,
  resolveContextualLocalTool,
  resolveDirectLocalTool,
  runNamedLocalTool,
  type LocalToolArgs,
  type LocalToolName,
  type LocalToolServices
} from "./localTools.js";
import { EchoBridge, type EchoBridgeEvent, type EchoPromptReply } from "./echoBridge.js";
import { createExternalLocalToolServices } from "./externalServices.js";
import { UserMemoryStore } from "./userMemory.js";
import { isRetryPrompt } from "./toolRetry.js";
import type { McpStatus, WorkerEvent } from "../shared/types.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
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

type PromptSource = "typed" | "echo" | "retry" | "fallback";
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
  ...createExternalLocalToolServices(),
  userMemory,
  spotify: config.spotify,
  captureScreen,
  analyzeScreen: analyzeScreenWithGemini,
  openApp: openLocalApp,
  openWebsite: openExternalWebsite,
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
      void respondWithFallback(activePrompt, "Pi exited while handling the request. Using direct Gemini fallback.");
    } else {
      broadcast("assistant:state", "idle");
    }
    return;
  }
  if ((event.type === "error" || event.type === "unavailable") && pendingPiPrompts.size > 0) {
    broadcast("pi:event", event);
    void respondWithFallback(activePrompt, "Pi failed while handling the request. Using direct Gemini fallback.");
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
        `${config.gemini.model} cannot run Pi tool calls. Using direct Gemini fallback.`
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
    } else {
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

async function handleUserPrompt(prompt: string): Promise<void> {
  const turnId = activeTurnId + 1;
  activeTurnId = turnId;
  pythonWorker.send({ type: "stop_speaking" });
  broadcast("assistant:state", "thinking");
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
    await retryLastTool(turnId, "gemini");
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
  const prompt = context.transcript.trim();
  const turnId = activeTurnId + 1;
  let toolUsed = false;
  activeTurnId = turnId;
  pythonWorker.send({ type: "stop_speaking" });
  echoBridge.setLed("active-thinking");
  broadcast("assistant:state", "thinking");
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
    return { text: await retryLastToolForEcho(turnId), toolUsed: true };
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
    debug(`echo gemini response starting device=${context.deviceId} promptChars=${prompt.length}`);
    emitDebugEvent("gemini request", {
      turnId,
      source: "echo",
      model: config.gemini.model,
      promptChars: prompt.length
    });
    const text = sanitizeAssistantText(
      await generateWithGemini(prompt, config, {
        history: getRecentHistory(),
        knownLocation,
        userMemory: userMemory.summary(),
        localToolServices,
        mcp,
        onToolEvent: (phase, result) => {
          if (phase === "start") {
            toolUsed = true;
          }
          broadcastLocalToolEvent(phase, { ...result, route: "gemini", source: "echo", turnId });
        }
      })
    );
    if (turnId !== activeTurnId) {
      debug(`echo response ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
      return "I already moved on to another request.";
    }
    activePrompt = null;
    emitDebugEvent("gemini response", { turnId, source: "echo", chars: text.length, toolUsed });
    rememberTurn("assistant", text);
    broadcastAssistantText(text, "echo");
    broadcast("assistant:state", "speaking");
    setTimeout(() => {
      if (activeTurnId === turnId) {
        broadcast("assistant:state", "idle");
      }
    }, 5000);
    return { text, toolUsed };
  } catch (error) {
    const message = `I could not reach Gemini. Check your GEMINI_API_KEY and network, then try again. ${String(error)}`;
    debug(`echo gemini response failed ${String(error)}`);
    emitDebugEvent("gemini failed", { turnId, source: "echo", error: String(error) });
    broadcastAssistantText(message, "error");
    rememberTurn("assistant", message);
    broadcast("assistant:state", "error");
    return message;
  }
}

async function runDirectLocalTool(prompt: string, context: { turnId: number; source: PromptSource }): Promise<string | null> {
  const directInvocation = resolveDirectLocalTool(prompt);
  const contextualInvocation =
    directInvocation ?? resolveContextualLocalTool(prompt, lastRetryableTool?.name ?? null);
  const invocation = directInvocation ?? contextualInvocation;
  const route = directInvocation ? "direct" : contextualInvocation ? "contextual-direct" : "direct";
  if (!invocation) {
    emitDebugEvent("route gemini", {
      turnId: context.turnId,
      source: context.source,
      previousTool: lastRetryableTool?.name,
      reason: "no direct or contextual local tool matched"
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
    const message = `Tool failed: ${String(error)}`;
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

async function retryLastTool(turnId: number, source: string): Promise<void> {
  const text = await runStoredToolRetry();
  if (turnId !== activeTurnId) {
    debug(`retry result ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
    return;
  }
  activePrompt = null;
  rememberTurn("assistant", text);
  broadcastAssistantText(text, source);
  pythonWorker.send({ type: "speak", text });
}

async function retryLastToolForEcho(turnId: number): Promise<string> {
  const text = await runStoredToolRetry();
  if (turnId !== activeTurnId) {
    debug(`echo retry ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
    return "I already moved on to another request.";
  }
  activePrompt = null;
  rememberTurn("assistant", text);
  broadcastAssistantText(text, "echo");
  broadcast("assistant:state", "speaking");
  setTimeout(() => {
    if (activeTurnId === turnId) {
      broadcast("assistant:state", "idle");
    }
  }, 5000);
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
    broadcastLocalToolEvent("end", {
      ...result,
      args: invocation.args,
      route: "retry",
      source: "retry",
      durationMs: Date.now() - startedAt
    });
    return result.text;
  } catch (error) {
    const message = `Retry failed: ${String(error)}`;
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
    debug(`gemini response starting promptChars=${prompt.length}`);
    emitDebugEvent("gemini request", {
      turnId,
      source: "typed",
      model: config.gemini.model,
      promptChars: prompt.length
    });
    broadcast("assistant:state", "thinking");
    const text = sanitizeAssistantText(
      await generateWithGemini(prompt, config, {
        history: getRecentHistory(),
        knownLocation,
        userMemory: userMemory.summary(),
        localToolServices,
        mcp,
        onToolEvent: (phase, result) =>
          broadcastLocalToolEvent(phase, { ...result, route: "gemini", source: "typed", turnId })
      })
    );
    if (turnId !== activeTurnId) {
      debug(`gemini response ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
      emitDebugEvent("stale gemini response ignored", { turnId, activeTurnId, source: "typed" });
      return;
    }
    debug(`gemini response complete chars=${text.length}`);
    emitDebugEvent("gemini response", { turnId, source: "typed", chars: text.length });
    activePrompt = null;
    rememberTurn("assistant", text);
    broadcastAssistantText(text, "gemini");
    pythonWorker.send({ type: "speak", text });
  } catch (error) {
    if (turnId !== activeTurnId) {
      debug(`gemini error ignored staleTurn=${turnId} activeTurn=${activeTurnId}`);
      emitDebugEvent("stale gemini error ignored", { turnId, activeTurnId, source: "typed" });
      return;
    }
    debug(`gemini response failed ${String(error)}`);
    emitDebugEvent("gemini failed", { turnId, source: "typed", error: String(error) });
    const message = `I could not reach Gemini. Check your GEMINI_API_KEY and network, then try again. ${String(error)}`;
    broadcastAssistantText(message, "error");
    rememberTurn("assistant", message);
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
    debug(`gemini response starting reason="${reason}" promptChars=${prompt.length}`);
    emitDebugEvent("gemini fallback request", {
      source: "fallback",
      model: config.gemini.model,
      promptChars: prompt.length,
      reason
    });
    broadcast("assistant:state", "thinking");
    broadcast("pi:event", {
      type: "fallback",
      payload: { type: "status", text: reason }
    });
    const text = sanitizeAssistantText(
      await generateWithGemini(prompt, config, {
        history: getRecentHistory(),
        knownLocation,
        userMemory: userMemory.summary(),
        localToolServices,
        mcp,
        onToolEvent: (phase, result) => broadcastLocalToolEvent(phase, { ...result, route: "fallback", source: "fallback" })
      })
    );
    debug(`gemini response complete chars=${text.length}`);
    emitDebugEvent("gemini fallback response", { source: "fallback", chars: text.length });
    activePrompt = null;
    rememberTurn("assistant", text);
    broadcastAssistantText(text, "gemini-fallback");
    pythonWorker.send({ type: "speak", text });
  } catch (error) {
    debug(`gemini response failed ${String(error)}`);
    emitDebugEvent("gemini fallback failed", { source: "fallback", error: String(error) });
    const message = `I could not reach Pi or Gemini. Check your GEMINI_API_KEY and network, then try again. ${String(error)}`;
    broadcastAssistantText(message, "error");
    rememberTurn("assistant", message);
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
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1920, height: 1080 }
  });
  const source = sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("No screen source was available to capture.");
  }
  const image = source.thumbnail;
  const size = image.getSize();
  const filePath = path.join(app.getPath("temp"), `pythos-screen-${Date.now()}.png`);
  fs.writeFileSync(filePath, image.toPNG());
  return { path: filePath, width: size.width, height: size.height };
}

async function analyzeScreenWithGemini(imagePath: string, prompt: string): Promise<string> {
  try {
    const apiKey = resolveGeminiApiKey(config);
    const image = fs.readFileSync(imagePath).toString("base64");
    const baseUrl = (config.gemini.baseUrl?.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(
      /\/+$/,
      ""
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    const url = `${baseUrl}/models/${encodeURIComponent(config.gemini.model)}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt || "Describe what is on this screen." },
              { inlineData: { mimeType: "image/png", data: image } }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512
        }
      })
    }).finally(() => clearTimeout(timeout));
    if (!response.ok) {
      return `I captured the screen, but ${config.gemini.model} could not analyze it: HTTP ${response.status}.`;
    }
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    };
    if (payload.error?.message) {
      return `I captured the screen, but ${config.gemini.model} could not analyze images: ${payload.error.message}.`;
    }
    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
    return text || "I captured the screen, but the vision response was empty.";
  } catch (error) {
    return `I captured the screen, but image analysis failed: ${String(error)}.`;
  }
}

async function openExternalWebsite(url: string): Promise<void> {
  await shell.openExternal(url);
}

function openLocalApp(target: string): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return shell.openExternal(target);
  }
  if (process.platform === "darwin") {
    return openLocalAppOnMac(target);
  }
  if (process.platform !== "win32") {
    return openLocalAppOnLinux(target);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(target, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.on("error", () => {
      openLocalAppWithPowerShell(target).then(resolve, reject);
    });
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function openLocalAppOnMac(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("open", ["-a", target], { stdio: "pipe" });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      // The app was not found by name; try opening it as a path or bundle.
      const fallback = spawn("open", [target], { detached: true, stdio: "ignore" });
      fallback.on("error", () => reject(new Error(stderr.trim() || `Could not open app ${target}.`)));
      fallback.on("spawn", () => {
        fallback.unref();
        resolve();
      });
    });
  });
}

function openLocalAppOnLinux(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(target, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      const fallback = spawn("xdg-open", [target], { detached: true, stdio: "ignore" });
      fallback.on("error", () => reject(new Error(`Could not open app ${target}.`)));
      fallback.on("spawn", () => {
        fallback.unref();
        resolve();
      });
    });
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function openLocalAppWithPowerShell(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const escaped = target.replace(/'/g, "''");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Start-Process -FilePath '${escaped}'`],
      { windowsHide: true, stdio: "pipe" }
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `Could not open app ${target}.`));
      }
    });
  });
}

function sanitizeAssistantText(text: string): string {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/°\s*F/gi, " degrees Fahrenheit")
    .replace(/°\s*C/gi, " degrees Celsius")
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "")
    .replace(/[\u{E0000}-\u{E007F}]/gu, "")
    .replace(/[\u200D\u20E3]/gu, "")
    .replace(/[^\u0009\u000A\u000D\u0020-\u007E\u00A0-\u024F]/gu, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\*+/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function clearPendingPiFallbacks(): void {
  for (const timer of pendingPiPrompts.values()) {
    clearTimeout(timer);
  }
  pendingPiPrompts.clear();
}

function extractAssistantText(payload: Record<string, unknown>): string {
  const candidates = [payload.text, payload.content, payload.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      if (typeof nested.text === "string" && nested.text.trim()) {
        return nested.text;
      }
      if (typeof nested.content === "string" && nested.content.trim()) {
        return nested.content;
      }
    }
  }
  return "";
}

function extractLastAssistantText(payload: Record<string, unknown>): string {
  const data = payload.data as Record<string, unknown> | undefined;
  const text = data?.text;
  return typeof text === "string" ? text.trim() : "";
}

function extractPiError(payload: Record<string, unknown> | undefined): string {
  if (!payload) {
    return "";
  }
  const candidates = [payload.error, payload.errorMessage, payload.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      if (typeof nested.errorMessage === "string" && nested.errorMessage.trim()) {
        return nested.errorMessage;
      }
      if (typeof nested.error === "string" && nested.error.trim()) {
        return nested.error;
      }
    }
  }
  return "";
}

function isUnsupportedToolModelError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("does not support tools") || normalized.includes("tools are not supported");
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

function compactDebugDetails(details: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    compact[key] = typeof value === "string" ? truncateDebugValue(value, 260) : value;
  }
  return compact;
}

function formatDebugFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
    .join(" ");
}

function formatDebugValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${truncateDebugValue(value)}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return truncateDebugValue(JSON.stringify(value));
}

function truncateDebugValue(value: string | undefined, maxLength = 240): string {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function debug(message: string): void {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.error(`[pythos-main ${timestamp}] ${message}`);
}
