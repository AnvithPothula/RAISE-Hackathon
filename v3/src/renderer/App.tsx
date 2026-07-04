import {
  AlertCircle,
  Download,
  History,
  MessageSquare,
  Mic,
  MicOff,
  Radio,
  Save,
  Search,
  Send,
  Settings,
  Square,
  Trash2,
  Wrench,
  X,
  Zap
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppConfig,
  AssistantState,
  ConversationItem,
  McpStatus,
  ModelStats,
  PiEvent,
  PiStatus,
  ThinkLevel,
  ThinkMode,
  WorkerEvent
} from "../shared/types";

const nowId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

type VoiceAction = "wakeword" | "mic";
type NodeStatus = "idle" | "listening" | "thinking" | "speaking" | "error";
type SettingsTab = "general" | "audio" | "tools" | "paths";

type ConnectedNode = {
  id: string;
  label: string;
  status: NodeStatus;
  lastSeen: number;
};

const QUICK_REPLIES = [
  "What can you do?",
  "What's on my screen?",
  "Open my calendar",
  "What's on my clipboard?",
  "Play something relaxing"
];

type SideTab = "chat" | "activity";

const TOOL_ICONS: Record<string, React.ElementType> = {
  spotify: Zap,
  system: Settings,
  browser: Zap,
  file: History,
  default: Wrench
};

export function App() {
  const [state, setState] = useState<AssistantState>("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [toolEvents, setToolEvents] = useState<PiEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [configSummary, setConfigSummary] = useState("Gemma (local, on-device)");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [pendingVoiceAction, setPendingVoiceAction] = useState<VoiceAction | null>(null);
  const [wakeSessionArmed, setWakeSessionArmed] = useState(false);
  const [piStatus, setPiStatus] = useState<PiStatus | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [typedPrompt, setTypedPrompt] = useState("");
  const [connectedNodes, setConnectedNodes] = useState<ConnectedNode[]>([]);
  const [inspectingNode, setInspectingNode] = useState<ConnectedNode | null>(null);
  const [toolFlashActive, setToolFlashActive] = useState(false);
  const [modelStats, setModelStats] = useState<ModelStats | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [searchQuery, setSearchQuery] = useState("");
  const [streamingText, setStreamingText] = useState<{ id: string; text: string } | null>(null);
  const [startTime] = useState(() => Date.now());
  const [showStats, setShowStats] = useState(false);
  const [sideWidth, setSideWidth] = useState(340);
  const [sideTab, setSideTab] = useState<SideTab>("chat");
  const [isResizing, setIsResizing] = useState(false);

  const toolFlashTimer = useRef<number | null>(null);
  const assistantTurnActiveRef = useRef(false);
  const promptRef = useRef<HTMLInputElement>(null);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(sideWidth);

  function markAssistantTurnActive(active: boolean) {
    assistantTurnActiveRef.current = active;
  }

  const statusText = useMemo(() => {
    if (state === "idle") return "Ready";
    if (state === "loading") return "Loading audio";
    if (state === "wakeword") return `Say ${String(config?.audio?.wakeWord ?? "mark")}`;
    if (state === "listening") return partial || "Listening";
    if (state === "thinking") return "Thinking";
    if (state === "speaking") return "Speaking";
    if (state === "error") return "Needs attention";
    return "Stopped";
  }, [partial, state, config]);

  const filteredConversation = useMemo(() => {
    if (!searchQuery.trim()) return conversation;
    const query = searchQuery.toLowerCase();
    return conversation.filter((item) => item.text.toLowerCase().includes(query));
  }, [conversation, searchQuery]);

  const filteredToolEvents = useMemo(() => {
    if (!searchQuery.trim()) return toolEvents;
    const query = searchQuery.toLowerCase();
    return toolEvents.filter((event) => summarizeEvent(event.payload).toLowerCase().includes(query));
  }, [toolEvents, searchQuery]);

  const uptime = useMemo(() => formatDurationMs(Date.now() - startTime), [startTime, state]);

  const visibleConversation = streamingText && !searchQuery.trim()
    ? [...filteredConversation, { id: streamingText.id, role: "assistant" as const, text: streamingText.text, timestamp: Date.now() }]
    : filteredConversation;

  function toggleMic() {
    if (!window.pythos) return setBridgeError();
    if (state === "listening") {
      setPendingVoiceAction("mic");
      setWakeSessionArmed(false);
      window.pythos.stopListening();
      setState("idle");
    } else {
      setError(null);
      setWakeSessionArmed(false);
      setPendingVoiceAction("mic");
      window.pythos.startListening().catch((reason: unknown) => {
        setPendingVoiceAction(null);
        setError(`Microphone failed: ${String(reason)}`);
        setState("error");
      });
    }
  }

  function toggleWakeword() {
    if (!window.pythos) return setBridgeError();
    if (wakeSessionArmed || state === "wakeword") {
      setPendingVoiceAction("wakeword");
      setWakeSessionArmed(false);
      window.pythos.stopListening();
      setState("idle");
    } else {
      setError(null);
      setWakeSessionArmed(true);
      setPendingVoiceAction("wakeword");
      window.pythos.startWakeword().catch((reason: unknown) => {
        setPendingVoiceAction(null);
        setError(`Wake word failed: ${String(reason)}`);
        setState("error");
      });
    }
  }

  function stopAll() {
    if (!window.pythos) return setBridgeError();
    window.pythos.stopListening();
    window.pythos.stopSpeaking();
    window.pythos.abortPi();
    setWakeSessionArmed(false);
    setPendingVoiceAction(null);
    setStreamingText(null);
    markAssistantTurnActive(false);
    setState("idle");
  }

  function submitTypedPrompt(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.pythos) return setBridgeError();
    const prompt = typedPrompt.trim();
    if (!prompt) return;
    setTypedPrompt("");
    setError(null);
    setWakeSessionArmed(false);
    setPendingVoiceAction(null);
    setConversation((items) => trimItems([...items, { id: nowId(), role: "user" as const, text: prompt, timestamp: Date.now() }], config));
    markAssistantTurnActive(true);
    setState("thinking");
    window.pythos.promptAssistant(prompt).catch((reason: unknown) => {
      setError(`Typed prompt failed: ${String(reason)}`);
      markAssistantTurnActive(false);
      setState("error");
    });
  }

  function sendQuickReply(text: string) {
    setTypedPrompt(text);
    setTimeout(() => promptRef.current?.form?.requestSubmit(), 0);
  }

  function clearContext() {
    setConversation([]);
    setToolEvents([]);
    setStreamingText(null);
    window.pythos?.clearAssistantContext();
  }

  function exportTranscript() {
    const data = {
      exportedAt: new Date().toISOString(),
      conversation,
      toolEvents: toolEvents.map((event) => ({ type: event.type, payload: event.payload }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pythos-transcript-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openSettings() {
    setSettingsDraft(config ? structuredClone(config) : null);
    setActiveTab("general");
    setSettingsOpen(true);
  }

  async function saveSettings() {
    if (!settingsDraft || !window.pythos) return;
    const saved = await window.pythos.saveConfig(settingsDraft);
    const nextPiStatus = await window.pythos.getPiStatus();
    const nextMcpStatus = await window.pythos.getMcpStatus?.().catch(() => null);
    setConfig(saved);
    setSettingsDraft(structuredClone(saved));
    setPiStatus(nextPiStatus);
    setMcpStatus(nextMcpStatus);
    setConfigSummary(formatRuntimeSummary(saved, nextPiStatus));
    setShowStats(Boolean(saved.gui?.showPerformanceStats));
    setSettingsOpen(false);
    setError(null);
  }

  function startResize(event: React.MouseEvent) {
    resizeStartX.current = event.clientX;
    resizeStartWidth.current = sideWidth;
    setIsResizing(true);
  }

  function triggerToolFlash() {
    if (toolFlashTimer.current !== null) window.clearTimeout(toolFlashTimer.current);
    setToolFlashActive(true);
    toolFlashTimer.current = window.setTimeout(() => {
      setToolFlashActive(false);
      toolFlashTimer.current = null;
    }, 500);
  }

  function setBridgeError() {
    setError("Electron preload bridge is unavailable.");
    setState("error");
  }

  function handleWorkerEvent(event: WorkerEvent) {
    if (event.type === "state") {
      const workerState = event.payload.value;
      setState((current) => {
        // The mic pipeline reports idle when PTT ends; don't clobber inference/TTS.
        if (workerState === "idle" && assistantTurnActiveRef.current) {
          return current;
        }
        return workerState;
      });
      if (workerState !== "loading") setPendingVoiceAction(null);
      if (workerState === "idle" || workerState === "error" || workerState === "shutdown") {
        if (!assistantTurnActiveRef.current) {
          setWakeSessionArmed(false);
        }
      }
      return;
    }
    if (event.type === "audio_level") {
      setAudioLevel(event.payload.value);
      return;
    }
    if (event.type === "partial_transcript") {
      setPartial(event.payload.text);
      return;
    }
    if (event.type === "final_transcript") {
      setPendingVoiceAction(null);
      setPartial("");
      setConversation((items) => trimItems([...items, { id: nowId(), role: "user" as const, text: event.payload.text, timestamp: Date.now() }], config));
      markAssistantTurnActive(true);
      setState("thinking");
      return;
    }
    if (event.type === "tts_started") {
      markAssistantTurnActive(true);
      setState("speaking");
      return;
    }
    if (event.type === "tts_done") {
      if (event.payload.cancelled) {
        return;
      }
      markAssistantTurnActive(false);
      setState("idle");
      return;
    }
    if (event.type === "error") {
      setPendingVoiceAction(null);
      setError(`${event.payload.source}: ${event.payload.message}`);
      setState("error");
    }
  }

  function handlePiEvent(event: PiEvent) {
    setToolEvents((events) => [event, ...events].slice(0, 25));
    setConnectedNodes((nodes) => updateConnectedNodes(nodes, event));
    const payload = event.payload as Record<string, unknown> | string;
    if (event.type === "error" || event.type === "unavailable") {
      setError(typeof payload === "string" ? payload : summarizeEvent(payload));
    }

    if (typeof payload === "object" && payload && "type" in payload) {
      const type = String(payload.type);
      if (type === "status") {
        setError(null);
        if (state === "error") setState("thinking");
      }
      if (type === "message_update") {
        const text = extractAssistantText(payload);
        if (text) {
          setError(null);
          setStreamingText((current) => ({ id: current?.id ?? nowId(), text }));
        }
      }
      if (type === "message_end") {
        const text = extractAssistantText(payload);
        if (text || streamingText) {
          setError(null);
          setConversation((items) => trimItems(upsertAssistant(items, text || streamingText?.text || "", streamingText?.id), config));
          setStreamingText(null);
        }
      }
      if (type === "tool_execution_start") {
        triggerToolFlash();
        setConversation((items) => trimItems([...items, { id: nowId(), role: "tool" as const, text: formatToolConversationText(payload), timestamp: Date.now() }], config));
      }
      if (type === "turn_end") {
        markAssistantTurnActive(false);
        setState("idle");
        setStreamingText(null);
      }
    }
  }

  useEffect(() => {
    if (!window.pythos) {
      setError("Electron preload bridge did not load. Rebuild and restart the app.");
      setState("error");
      return;
    }

    window.pythos.getConfig().then((loadedConfig) => {
      setConfig(loadedConfig);
      setSettingsDraft(loadedConfig);
      setShowStats(Boolean(loadedConfig.gui?.showPerformanceStats));
      setConfigSummary(formatRuntimeSummary(loadedConfig, piStatus));
    }).catch((reason: unknown) => {
      setError(`Config load failed: ${String(reason)}`);
      setState("error");
    });

    window.pythos.getPiStatus().then((status) => setPiStatus(status)).catch((reason: unknown) => {
      setPiStatus({ enabled: false, available: false, running: false, command: null, args: [], reason: `Pi status failed: ${String(reason)}` });
    });

    window.pythos.getMcpStatus?.().then((status) => setMcpStatus(status)).catch(() => {
      setMcpStatus({ enabled: false, servers: [] });
    });

    const offWorker = window.pythos.onWorkerEvent(handleWorkerEvent);
    const offPi = window.pythos.onPiEvent(handlePiEvent);
    const offPiStatus = window.pythos.onPiStatus((status) => setPiStatus(status));
    const offMcpStatus = window.pythos.onMcpStatus?.((status) => setMcpStatus(status)) ?? (() => {});
    const offState = window.pythos.onAssistantState((next) => {
      const assistantState = next as AssistantState;
      if (assistantState === "thinking" || assistantState === "speaking") {
        markAssistantTurnActive(true);
      } else if (assistantState === "idle" || assistantState === "error" || assistantState === "shutdown") {
        markAssistantTurnActive(false);
      }
      setState(assistantState);
    });
    const offStats = window.pythos.onModelStats((stats) => setModelStats(stats));
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
        if (event.key === "Escape") (event.target as HTMLElement).blur();
        return;
      }
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        toggleMic();
      } else if (event.key === "w" || event.key === "W") {
        toggleWakeword();
      } else if (event.key === "Escape") {
        stopAll();
      } else if (event.key === "/" || event.key === "?") {
        event.preventDefault();
        promptRef.current?.focus();
      } else if (event.key === "," || event.key === "<") {
        openSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      offWorker();
      offPi();
      offPiStatus();
      offMcpStatus();
      offState();
      offStats();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("keydown", onKeyDown);
      if (toolFlashTimer.current !== null) window.clearTimeout(toolFlashTimer.current);
    };
  }, []);

  useEffect(() => {
    if (config) setConfigSummary(formatRuntimeSummary(config, piStatus));
  }, [config, piStatus]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      const next = Math.min(Math.max(resizeStartWidth.current + resizeStartX.current - event.clientX, 300), 600);
      setSideWidth(next);
      document.documentElement.style.setProperty("--side-width", `${next}px`);
    };
    const onUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isResizing]);

  return (
    <main className="app-shell" style={{ "--side-width": `${sideWidth}px` } as React.CSSProperties}>
      <section className="stage">
        <AiChamber
          state={state}
          statusText={statusText}
          configSummary={configSummary}
          online={online}
          modelStats={modelStats}
          showPerf={Boolean(config?.gui?.showPerformanceStats)}
          audioLevel={audioLevel}
          toolFlashActive={toolFlashActive}
          showStats={showStats}
          uptime={uptime}
          conversationLength={conversation.length}
          connectedNodes={connectedNodes}
          onInspect={setInspectingNode}
          onToggle={state === "listening" ? stopAll : toggleMic}
        />

        <ControlDock
          state={state}
          wakeSessionArmed={wakeSessionArmed}
          pendingVoiceAction={pendingVoiceAction}
          typedPrompt={typedPrompt}
          onToggleWakeword={toggleWakeword}
          onToggleMic={toggleMic}
          onStop={stopAll}
          onClear={clearContext}
          onSettings={openSettings}
          onTypedPromptChange={setTypedPrompt}
          onSubmit={submitTypedPrompt}
          onQuickReply={sendQuickReply}
          promptRef={promptRef}
        />

        {error && (
          <div className="error-banner">
            <AlertCircle size={18} />
            {error}
          </div>
        )}
      </section>

      <SidePanel
        sideTab={sideTab}
        onSideTabChange={setSideTab}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        visibleConversation={visibleConversation}
        streamingText={streamingText}
        toolEvents={filteredToolEvents}
        mcpStatus={mcpStatus}
        onExport={exportTranscript}
        onClear={clearContext}
        onClearToolEvents={() => setToolEvents([])}
        isResizing={isResizing}
        onResizeStart={startResize}
      />

      {settingsOpen && (
        <SettingsModal
          activeTab={activeTab}
          onTabChange={setActiveTab}
          state={state}
          piStatus={piStatus}
          config={config}
          settingsDraft={settingsDraft}
          onDraftChange={setSettingsDraft}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
        />
      )}

      {inspectingNode && (
        <NodeInspector node={inspectingNode} onClose={() => setInspectingNode(null)} />
      )}

    </main>
  );
}

function AiChamber({
  state,
  statusText,
  configSummary,
  online,
  modelStats,
  showPerf,
  audioLevel,
  toolFlashActive,
  showStats,
  uptime,
  conversationLength,
  connectedNodes,
  onInspect,
  onToggle
}: {
  state: AssistantState;
  statusText: string;
  configSummary: string;
  online: boolean;
  modelStats: ModelStats | null;
  showPerf: boolean;
  audioLevel: number;
  toolFlashActive: boolean;
  showStats: boolean;
  uptime: string;
  conversationLength: number;
  connectedNodes: ConnectedNode[];
  onInspect: (node: ConnectedNode) => void;
  onToggle: () => void;
}) {
  const perfHint =
    showPerf && modelStats && modelStats.tokensPerSecond > 0
      ? ` · ${modelStats.tokensPerSecond} tok/s${modelStats.toolScope ? ` · tools:${modelStats.toolScope}` : ""}`
      : modelStats?.toolScope
        ? ` · tools:${modelStats.toolScope}`
        : "";

  const stateLabel = useMemo(() => {
    if (state === "idle") return "Standby";
    if (state === "loading") return "Initializing";
    if (state === "wakeword") return "Wake word";
    if (state === "listening") return "Listening";
    if (state === "thinking") return "Processing";
    if (state === "speaking") return "Responding";
    if (state === "error") return "Attention";
    return "Offline";
  }, [state]);

  return (
    <section className="ai-chamber" aria-label="AI core">
      <header className="ai-chamber-header">
        <div className="brand-mark">
          <span className={`eyebrow-dot ${state}`} aria-hidden="true" />
          <span>Pythos</span>
        </div>
        {showStats && (
          <div className="performance-stats">
            {uptime} · {conversationLength} msgs · {connectedNodes.length} nodes
          </div>
        )}
      </header>

      <div className="ai-core">
        <div className="neural-field" aria-hidden="true">
          <div className="neural-ring ring-1" />
        </div>

        <div
          className={`orb-wrap ${state}${toolFlashActive ? " tool-flash" : ""}`}
          style={{ "--level": audioLevel } as React.CSSProperties}
          onClick={onToggle}
          role="button"
          tabIndex={0}
          aria-label={state === "listening" ? "Stop listening" : "Start push to talk"}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggle();
            }
          }}
        >
          <div className="orb-glow" />
          <div className="neural-nodes" aria-label="Connected nodes">
            {connectedNodes.map((node, index) => (
              <NodeOrbit
                key={node.id}
                node={node}
                index={index}
                count={connectedNodes.length}
                onInspect={() => onInspect(node)}
              />
            ))}
          </div>
          <div className="orb">
            <div className="orb-core" />
            <div className="pulse-ring one" />
          </div>
          <span className="orb-label">{state === "listening" ? "Tap to stop" : "Tap to talk"}</span>
        </div>
      </div>

      <div className="ai-status">
        <p className="ai-state-label">{stateLabel}</p>
        <h1 className="ai-status-text">{statusText}</h1>
        <p className="ai-status-meta">
          {configSummary}
          {!online && " · Offline"}
          {connectedNodes.length > 0 && (
            <span className="remote-link-hint"> · {connectedNodes.length} remote{connectedNodes.length === 1 ? "" : "s"} linked</span>
          )}
          {perfHint}
        </p>
      </div>
    </section>
  );
}

function ControlDock({
  state,
  wakeSessionArmed,
  pendingVoiceAction,
  typedPrompt,
  onToggleWakeword,
  onToggleMic,
  onStop,
  onClear,
  onSettings,
  onTypedPromptChange,
  onSubmit,
  onQuickReply,
  promptRef
}: {
  state: AssistantState;
  wakeSessionArmed: boolean;
  pendingVoiceAction: VoiceAction | null;
  typedPrompt: string;
  onToggleWakeword: () => void;
  onToggleMic: () => void;
  onStop: () => void;
  onClear: () => void;
  onSettings: () => void;
  onTypedPromptChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onQuickReply: (text: string) => void;
  promptRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="control-dock">
      <form className="text-prompt" onSubmit={onSubmit}>
        <input
          ref={promptRef}
          value={typedPrompt}
          onChange={(event) => onTypedPromptChange(event.target.value)}
          placeholder="Ask Pythos anything…"
          aria-label="Type a prompt"
        />
        <button className="text-send" type="submit" title="Send (Enter)" disabled={!typedPrompt.trim()}>
          <Send size={18} />
        </button>
      </form>

      <div className="controls" aria-label="Voice controls">
        <button
          className={voiceButtonClass("wakeword", wakeSessionArmed || state === "wakeword", pendingVoiceAction)}
          onClick={onToggleWakeword}
          title={wakeSessionArmed || state === "wakeword" ? "Stop wake word (W)" : "Arm wake word (W)"}
          aria-pressed={wakeSessionArmed || state === "wakeword"}
        >
          <Radio size={18} />
          <span>Wake</span>
        </button>
        <button
          className={voiceButtonClass("mic", state === "listening", pendingVoiceAction)}
          onClick={onToggleMic}
          title={state === "listening" ? "Stop listening (Space)" : "Start push to talk (Space)"}
          aria-pressed={state === "listening"}
        >
          {state === "listening" ? <MicOff size={18} /> : <Mic size={18} />}
          <span>{state === "listening" ? "Stop" : "Talk"}</span>
        </button>
        <button className="icon-button ghost" onClick={onStop} title="Stop (Esc)">
          <Square size={18} />
        </button>
        <button className="icon-button ghost" onClick={onClear} title="Clear transcript">
          <Trash2 size={18} />
        </button>
        <button className="icon-button ghost" onClick={onSettings} title="Settings (,)">
          <Settings size={18} />
        </button>
      </div>

      <div className="quick-replies">
        {QUICK_REPLIES.map((text) => (
          <button key={text} className="quick-reply" type="button" onClick={() => onQuickReply(text)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function SidePanel({
  sideTab,
  onSideTabChange,
  searchQuery,
  onSearchChange,
  visibleConversation,
  streamingText,
  toolEvents,
  mcpStatus,
  onExport,
  onClear,
  onClearToolEvents,
  isResizing,
  onResizeStart
}: {
  sideTab: SideTab;
  onSideTabChange: (tab: SideTab) => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  visibleConversation: ConversationItem[];
  streamingText: { id: string; text: string } | null;
  toolEvents: PiEvent[];
  mcpStatus: McpStatus | null;
  onExport: () => void;
  onClear: () => void;
  onClearToolEvents: () => void;
  isResizing: boolean;
  onResizeStart: (event: React.MouseEvent) => void;
}) {
  const activityCount = toolEvents.length;

  return (
    <aside className="side-panel">
      <div className={`resize-handle ${isResizing ? "dragging" : ""}`} onMouseDown={onResizeStart} title="Drag to resize" />

      <section className="panel-section side-panel-main">
        <header className="side-panel-header">
          <div className="side-panel-header-row">
            <div className="side-tabs" role="tablist" aria-label="Sidebar panels">
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === "chat"}
                className={`side-tab ${sideTab === "chat" ? "active" : ""}`}
                onClick={() => onSideTabChange("chat")}
              >
                <MessageSquare size={14} />
                Chat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === "activity"}
                className={`side-tab ${sideTab === "activity" ? "active" : ""}`}
                onClick={() => onSideTabChange("activity")}
              >
                <Zap size={14} />
                Activity
                {activityCount > 0 && <span className="side-tab-badge">{activityCount}</span>}
              </button>
            </div>
            <div className="panel-actions">
            {sideTab === "chat" && (
              <>
                <div className="search-bar">
                  <Search size={13} />
                  <input
                    value={searchQuery}
                    onChange={(event) => onSearchChange(event.target.value)}
                    placeholder="Search"
                    aria-label="Search transcript"
                  />
                </div>
                <button className="panel-action" onClick={onExport} title="Export transcript">
                  <Download size={14} />
                </button>
                <button className="panel-action" onClick={onClear} title="Clear transcript">
                  <Trash2 size={14} />
                </button>
              </>
            )}
            {sideTab === "activity" && (
              <button className="panel-action" onClick={onClearToolEvents} title="Clear activity">
                <Trash2 size={14} />
              </button>
            )}
          </div>
          </div>
        </header>

        {sideTab === "chat" ? (
          <div className="conversation-list" role="tabpanel">
            {visibleConversation.length === 0 ? (
              <div className="empty-state">
                <MessageSquare size={28} />
                <p>No messages yet</p>
                <small>Use the mic or type below to start.</small>
              </div>
            ) : (
              visibleConversation.map((item) => (
                <article className={`message ${item.role}`} key={item.id}>
                  <header>
                    <span>{roleLabel(item.role)}</span>
                    <time>{formatTime(item.timestamp)}</time>
                  </header>
                  <p className={streamingText?.id === item.id ? "streaming" : ""}>{item.text}</p>
                </article>
              ))
            )}
          </div>
        ) : (
          <div className="activity-panel" role="tabpanel">
            {mcpStatus?.enabled && mcpStatus.servers.length > 0 && (
              <div className="activity-block">
                <h3>Connectors</h3>
                <div className="mcp-list compact">
                  {mcpStatus.servers.map((server) => (
                    <div className={`mcp-row ${server.connected ? "connected" : "disconnected"}`} key={server.name}>
                      <span>{server.name}</span>
                      <span>{server.connected ? `${server.toolCount} tools` : "offline"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="activity-block fill">
              <h3>Tool runs</h3>
              <div className="tool-list">
                {toolEvents.length === 0 ? (
                  <div className="empty-state compact">
                    <Wrench size={24} />
                    <p>No tool activity</p>
                  </div>
                ) : (
                  toolEvents.map((event, index) => <ToolEventCard event={event} key={`${event.type}-${index}`} />)
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </aside>
  );
}

function SettingsModal({
  activeTab,
  onTabChange,
  state,
  piStatus,
  config,
  settingsDraft,
  onDraftChange,
  onClose,
  onSave
}: {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  state: AssistantState;
  piStatus: PiStatus | null;
  config: AppConfig | null;
  settingsDraft: AppConfig | null;
  onDraftChange: React.Dispatch<React.SetStateAction<AppConfig | null>>;
  onClose: () => void;
  onSave: () => void;
}) {
  const tabs: SettingsTab[] = ["general", "audio", "tools", "paths"];
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div>
            <p className="eyebrow">Runtime</p>
            <h2>Settings</h2>
          </div>
          <button className="text-button" onClick={onClose}>Close</button>
        </header>

        <div className="settings-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab}
              className={`settings-tab ${activeTab === tab ? "active" : ""}`}
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => onTabChange(tab)}
            >
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {activeTab === "general" && (
          <div className="settings-grid single-col">
            <Setting label="Assistant state" value={state} />
            <Setting label="Pi status" value={formatPiStatus(piStatus)} />
            <Setting label="Brain" value={brainSummary(settingsDraft)} />
            <SettingSelect
              label="LLM provider"
              value={settingsDraft?.openrouter?.enabled ? "openrouter" : "ollama"}
              options={[
                { label: "Local Ollama (on-device)", value: "ollama" },
                { label: "OpenRouter (cloud Gemma 4 31B free)", value: "openrouter" }
              ]}
              onChange={(value) => updateDraft(onDraftChange, ["openrouter", "enabled"], value === "openrouter")}
            />
            {settingsDraft?.openrouter?.enabled ? (
              <>
                <SettingInput
                  label="OpenRouter API key"
                  value={settingsDraft?.openrouter?.apiKey ?? ""}
                  type="password"
                  hint="Stored locally on this device. Get a key at openrouter.ai/keys"
                  onChange={(value) => updateDraft(onDraftChange, ["openrouter", "apiKey"], value)}
                />
                <SettingInput
                  label="OpenRouter model"
                  value={settingsDraft?.openrouter?.model ?? "google/gemma-4-31b-it:free"}
                  onChange={(value) => updateDraft(onDraftChange, ["openrouter", "model"], value)}
                />
              </>
            ) : null}
            <SettingSelect
              label="Adaptive thinking"
              value={settingsDraft?.ollama?.think ?? "auto"}
              options={[
                { label: "Auto (task-based)", value: "auto" },
                { label: "Always on", value: "on" },
                { label: "Always off (fastest)", value: "off" }
              ]}
              onChange={(value) => updateDraft(onDraftChange, ["ollama", "think"], value as ThinkMode)}
            />
            <SettingSelect
              label="Thinking depth"
              value={settingsDraft?.ollama?.thinkLevel ?? "medium"}
              options={[
                { label: "None", value: "none" },
                { label: "Low", value: "low" },
                { label: "Medium", value: "medium" },
                { label: "High", value: "high" }
              ]}
              onChange={(value) => updateDraft(onDraftChange, ["ollama", "thinkLevel"], value as ThinkLevel)}
            />
            <SettingSelect
              label="Visualizer style"
              value={settingsDraft?.gui?.visualizer ?? "orb"}
              options={[
                { label: "Orb", value: "orb" },
                { label: "Compact", value: "compact" },
                { label: "Minimal", value: "minimal" }
              ]}
              onChange={(value) => updateDraft(onDraftChange, ["gui", "visualizer"], value)}
            />
            <SettingNumber
              label="Max transcript items"
              value={Number(settingsDraft?.gui?.maxTranscriptItems ?? 100)}
              min={20}
              max={500}
              step={10}
              onChange={(value) => updateDraft(onDraftChange, ["gui", "maxTranscriptItems"], value)}
            />
            <SettingToggle
              label="Show performance stats"
              checked={Boolean(settingsDraft?.gui?.showPerformanceStats)}
              onChange={(value) => updateDraft(onDraftChange, ["gui", "showPerformanceStats"], value)}
            />
            <SettingInput
              label="Ollama endpoint"
              value={settingsDraft?.ollama?.baseUrl ?? "http://127.0.0.1:11434"}
              onChange={(value) => updateDraft(onDraftChange, ["ollama", "baseUrl"], value)}
            />
            <SettingInput
              label="Low-resource model"
              value={settingsDraft?.ollama?.lowResourceModel ?? "gemma4:e2b"}
              onChange={(value) => updateDraft(onDraftChange, ["ollama", "lowResourceModel"], value)}
            />
            <SettingToggle
              label={`Low resource mode (${settingsDraft?.ollama?.lowResourceModel ?? "gemma4:e2b"})`}
              checked={Boolean(settingsDraft?.python?.lowResourceMode)}
              onChange={(value) => updateDraft(onDraftChange, ["python", "lowResourceMode"], value)}
            />
          </div>
        )}

        {activeTab === "audio" && (
          <div className="settings-grid single-col">
            <SettingInput
              label="Wake word"
              value={String(settingsDraft?.audio?.wakeWord ?? "")}
              onChange={(value) => updateDraft(onDraftChange, ["audio", "wakeWord"], value)}
            />
            <SettingNumber
              label="Wake threshold"
              value={Number(settingsDraft?.audio?.wakeThreshold ?? 0.5)}
              min={0.1}
              max={0.95}
              step={0.05}
              onChange={(value) => updateDraft(onDraftChange, ["audio", "wakeThreshold"], value)}
            />
            <SettingNumber
              label="Speech speed"
              value={Number(settingsDraft?.audio?.ttsLengthScale ?? 0.8)}
              min={0.5}
              max={1.6}
              step={0.05}
              onChange={(value) => updateDraft(onDraftChange, ["audio", "ttsLengthScale"], value)}
              hint="Lower is faster"
            />
            <SettingNumber
              label="ASR timeout"
              value={Number(settingsDraft?.audio?.asrTimeoutSeconds ?? 10)}
              min={3}
              max={30}
              step={1}
              onChange={(value) => updateDraft(onDraftChange, ["audio", "asrTimeoutSeconds"], value)}
            />
            <SettingNumber
              label="Silence timeout"
              value={Number(settingsDraft?.audio?.silenceTimeoutSeconds ?? 3)}
              min={1}
              max={10}
              step={0.5}
              onChange={(value) => updateDraft(onDraftChange, ["audio", "silenceTimeoutSeconds"], value)}
            />
          </div>
        )}

        {activeTab === "tools" && (
          <div className="settings-grid single-col">
            <SettingToggle
              label="Experimental Pi tools"
              checked={Boolean(settingsDraft?.pi?.enabled)}
              onChange={(value) => updateDraft(onDraftChange, ["pi", "enabled"], value)}
            />
            <SettingInput
              label="Pi command"
              value={settingsDraft?.pi?.command ?? "pi"}
              onChange={(value) => updateDraft(onDraftChange, ["pi", "command"], value)}
            />
            <SettingInput
              label="Spotify client ID"
              value={settingsDraft?.spotify?.clientId ?? ""}
              onChange={(value) => updateDraft(onDraftChange, ["spotify", "clientId"], value)}
            />
            <SettingInput
              label="Spotify redirect URI"
              value={settingsDraft?.spotify?.redirectUri ?? "http://127.0.0.1:8888/callback"}
              onChange={(value) => updateDraft(onDraftChange, ["spotify", "redirectUri"], value)}
            />
            <SettingToggle
              label="MCP servers"
              checked={Boolean(settingsDraft?.mcp?.enabled)}
              onChange={(value) => updateDraft(onDraftChange, ["mcp", "enabled"], value)}
            />
          </div>
        )}

        {activeTab === "paths" && (
          <section className="settings-block">
            <h3>Model Paths</h3>
            <div className="path-list">
              {config?.models ? (
                Object.entries(config.models).map(([key, value]) => (
                  <div className="path-row" key={key}>
                    <span>{key}</span>
                    <code>{value}</code>
                  </div>
                ))
              ) : (
                <p className="muted">No model paths loaded.</p>
              )}
            </div>
          </section>
        )}

        <div className="settings-actions">
          <span>{formatPiCommand(settingsDraft ?? config)}</span>
          <button className="text-button save" onClick={onSave}>
            <Save size={16} />
            Save
          </button>
        </div>
      </section>
    </div>
  );
}

function NodeInspector({ node, onClose }: { node: ConnectedNode; onClose: () => void }) {
  return (
    <div className="node-inspector">
      <header>
        <h4>{node.label}</h4>
        <button className="panel-action" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <dl>
        <dt>ID</dt>
        <dd>{node.id}</dd>
        <dt>Status</dt>
        <dd>{formatNodeStatus(node.status)}</dd>
        <dt>Last seen</dt>
        <dd>{formatTime(node.lastSeen)}</dd>
      </dl>
    </div>
  );
}

function NodeOrbit({
  node,
  index,
  count,
  onInspect
}: {
  node: ConnectedNode;
  index: number;
  count: number;
  onInspect: () => void;
}) {
  const total = Math.max(count, 1);
  const angle = (index * 360) / total;
  const style = {
    "--node-index": index,
    "--node-angle": `${angle}deg`,
    "--node-end-angle": `${angle + 360}deg`,
    "--node-counter-angle": `${-angle}deg`,
    "--node-end-counter-angle": `${-(angle + 360)}deg`,
    "--orbit-duration": `${22 + index * 2}s`
  } as React.CSSProperties;

  return (
    <div className={`node-orbit ${node.status}`} style={style}>
      <span className="node-thread" aria-hidden="true" />
      <div
        className="node-anchor"
        onClick={onInspect}
        role="button"
        tabIndex={0}
        aria-label={`Inspect ${node.label}`}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onInspect();
        }}
      >
        <div className="node-body">
          <div className="node-orb" title={`${node.label}: ${formatNodeStatus(node.status)}`}>
            <span className="node-status-dot" />
          </div>
          <span className="node-label">{node.label}</span>
        </div>
      </div>
    </div>
  );
}

function ToolEventCard({ event }: { event: PiEvent }) {
  const payload = event.payload as Record<string, unknown> | string;
  const type = typeof payload === "object" && payload ? String((payload as Record<string, unknown>).type ?? event.type) : event.type;
  const phase = type.replace("tool_execution_", "");
  const name = typeof payload === "object" && payload ? humanToolName((payload as Record<string, unknown>).name) : "Tool";
  const Icon = TOOL_ICONS[phase === "start" ? "started" : phase === "end" ? "end" : phase === "error" ? "error" : "default"] ?? Wrench;
  const args = typeof payload === "object" && payload ? objectField(payload as Record<string, unknown>, "args") : null;
  const duration = typeof payload === "object" && payload ? (payload as Record<string, unknown>).durationMs : undefined;
  const error = typeof payload === "object" && payload ? stringField(payload as Record<string, unknown>, "errorMessage") : "";

  return (
    <article className="tool-event">
      <header>
        <span>
          <span className={`tool-icon ${phase}`}>
            <Icon size={14} />
          </span>
          {labelEvent(event)}
        </span>
        <time>{formatTime(Date.now())}</time>
      </header>
      <div className="tool-body">
        <code title={fullEventPayload(event.payload)}>{summarizeEvent(event.payload)}</code>
        {(args || duration !== undefined || error) && (
          <div className="tool-meta">
            {args && <span>args</span>}
            {duration !== undefined && <span>{formatDuration(duration)}</span>}
            {error && <span style={{ color: "var(--error)" }}>failed</span>}
          </div>
        )}
      </div>
    </article>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function voiceButtonClass(action: VoiceAction, active: boolean, pending: VoiceAction | null): string {
  const classes = ["icon-button", "voice-button"];
  if (active) classes.push("active");
  if (pending === action) classes.push("loading");
  return classes.join(" ");
}

function SettingInput({
  label,
  value,
  onChange,
  type = "text",
  hint
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="setting-row editable">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
      {hint ? <span className="setting-hint">{hint}</span> : null}
    </label>
  );
}

function SettingSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="setting-row editable">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function SettingNumber({
  label,
  value,
  min,
  max,
  step,
  hint,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="setting-row editable">
      <span>{label}</span>
      <div className="number-control">
        <input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
        <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} />
      </div>
      {hint && <small>{hint}</small>}
    </label>
  );
}

function SettingToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="setting-row editable toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function updateDraft(
  setSettingsDraft: React.Dispatch<React.SetStateAction<AppConfig | null>>,
  path: [keyof AppConfig, string],
  value: unknown
): void {
  setSettingsDraft((current) => {
    if (!current) return current;
    const next = structuredClone(current) as AppConfig;
    const nextRecord = next as unknown as Record<keyof AppConfig, unknown>;
    const existingGroup = nextRecord[path[0]];
    const group = existingGroup && typeof existingGroup === "object" && !Array.isArray(existingGroup) ? (existingGroup as Record<string, unknown>) : {};
    nextRecord[path[0]] = group;
    group[path[1]] = value;
    return next;
  });
}

function extractAssistantText(payload: Record<string, unknown>): string {
  const text = payload.text ?? payload.content ?? payload.message;
  return typeof text === "string" ? text : "";
}

function upsertAssistant(items: ConversationItem[], text: string, existingId?: string): ConversationItem[] {
  if (existingId) {
    const index = items.findIndex((item) => item.id === existingId);
    if (index >= 0) {
      const updated = [...items];
      updated[index] = { ...items[index], text };
      return updated;
    }
  }
  const last = items.at(-1);
  if (last?.role === "assistant") return [...items.slice(0, -1), { ...last, text }];
  return [...items, { id: existingId ?? nowId(), role: "assistant", text, timestamp: Date.now() }];
}

function trimItems(items: ConversationItem[], config: AppConfig | null): ConversationItem[] {
  const max = config?.gui?.maxTranscriptItems ?? 100;
  if (items.length <= max) return items;
  return items.slice(items.length - max);
}

function roleLabel(role: ConversationItem["role"]): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Pythos";
  if (role === "tool") return "Tool";
  return "System";
}

function updateConnectedNodes(nodes: ConnectedNode[], event: PiEvent): ConnectedNode[] {
  const echoEvent = extractEchoEvent(event);
  if (!echoEvent) return nodes;
  const payload = echoEvent.payload;
  if (!payload || typeof payload !== "object") return nodes;
  const record = payload as Record<string, unknown>;
  const deviceId = typeof record.deviceId === "string" && record.deviceId.trim() ? record.deviceId.trim() : "";
  if (!deviceId) return nodes;
  const eventType = String(record.type ?? echoEvent.type);
  if (eventType === "offline" || eventType === "disconnected") return nodes.filter((node) => node.id !== deviceId);
  const existingIndex = nodes.findIndex((node) => node.id === deviceId);
  const existingNode = existingIndex >= 0 ? nodes[existingIndex] : null;
  if (echoEvent.type === "realtime_state" && !existingNode) return nodes;
  const label = extractNodeLabel(record, deviceId, existingNode?.label);
  const status = eventType === "audio_level" && existingNode ? existingNode.status : deriveNodeStatus(echoEvent.type, eventType, record);
  const nextNode: ConnectedNode = { id: deviceId, label, status, lastSeen: Date.now() };
  const nextNodes = existingIndex >= 0
    ? nodes.map((node, index) => (index === existingIndex ? { ...node, ...nextNode } : node))
    : [...nodes, nextNode];
  return nextNodes.sort((left, right) => right.lastSeen - left.lastSeen).slice(0, 8);
}

function extractEchoEvent(event: PiEvent): { type: string; payload: unknown } | null {
  if (event.type !== "echo" || !event.payload || typeof event.payload !== "object") return null;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.type !== "string") return null;
  return { type: payload.type, payload: payload.payload };
}

function extractNodeLabel(record: Record<string, unknown>, deviceId: string, fallbackLabel?: string): string {
  const candidates = [record.deviceName, record.name, record.label, record.friendlyName];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 24);
  }
  if (fallbackLabel) return fallbackLabel;
  if (/echo|alexa/i.test(deviceId)) return "Alexa";
  return deviceId.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 24);
}

function deriveNodeStatus(echoType: string, eventType: string, record: Record<string, unknown>): NodeStatus {
  if (echoType === "error" || eventType === "error") return "error";
  const value = typeof record.value === "string" ? record.value : "";
  if (eventType === "listening" || eventType === "wake" || value === "listening" || value === "wakeword") return "listening";
  if (echoType === "upload_started" || echoType === "transcript" || eventType === "final_transcript") return "thinking";
  if (echoType === "reply" || eventType === "tts_play_requested" || eventType === "play_audio") return "speaking";
  if (eventType === "idle" || eventType === "online" || eventType === "status" || eventType === "heartbeat") return "idle";
  if (echoType === "realtime_state" && value === "thinking") return "thinking";
  return "idle";
}

function formatNodeStatus(status: NodeStatus): string {
  if (status === "idle") return "Idle";
  if (status === "listening") return "Listening";
  if (status === "thinking") return "Thinking";
  if (status === "speaking") return "Responding";
  return "Error";
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDurationMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
  parts.push(`${seconds % 60}s`);
  return parts.join(" ");
}

function summarizeEvent(payload: unknown): string {
  if (typeof payload === "string") return payload.slice(0, 160);
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const type = String(record.type ?? "");
    if (type === "debug") return summarizeDebugEvent(record);
    if (type === "tool_execution_start" || type === "tool_execution_end" || type === "tool_execution_error") return summarizeToolEvent(record);
    if (typeof record.text === "string") return record.text.slice(0, 220);
    if (typeof record.errorMessage === "string") return record.errorMessage.slice(0, 220);
    if (typeof record.code === "number" || record.code === null) {
      if (record.code === 4294967295) return "Pi process exited. Local Gemma will handle active requests.";
      return `Process exited with code ${String(record.code ?? "unknown")}`;
    }
    const message = record.message as Record<string, unknown> | undefined;
    if (typeof message?.errorMessage === "string") return message.errorMessage.slice(0, 220);
  }
  if (typeof payload === "string" && payload.trim()) return payload.trim().slice(0, 220);
  return JSON.stringify(payload).slice(0, 220);
}

function labelEvent(event: PiEvent): string {
  const payload = event.payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const type = String(record.type ?? event.type);
    if (type === "status") return "Status";
    if (type === "debug") return "Debug";
    if (type === "message_end") return event.type === "gemma-fallback" ? "Gemma (fallback)" : "Assistant";
    if (type === "tool_execution_start") return `Started - ${humanToolName(record.name)}`;
    if (type === "tool_execution_end") return `Finished - ${humanToolName(record.name)}`;
    if (type === "tool_execution_error") return `Failed - ${humanToolName(record.name)}`;
    if (type === "agent_start") return "Pi Started";
    if (type === "agent_end") return "Pi Finished";
  }
  if (event.type === "exit") return "Pi Exit";
  if (event.type === "stderr") return "Pi Log";
  return event.type;
}

function summarizeDebugEvent(record: Record<string, unknown>): string {
  const text = stringField(record, "text") || "Debug event";
  const parts = [text];
  for (const key of ["turnId", "source", "route", "tool", "reason", "model", "promptChars", "chars", "toolUsed"]) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") parts.push(`${key}=${formatEventValue(record[key])}`);
  }
  if (typeof record.prompt === "string") parts.push(`prompt=${formatEventValue(record.prompt)}`);
  if (record.args && typeof record.args === "object") parts.push(summarizeArgs(record.args as Record<string, unknown>));
  if (typeof record.error === "string") parts.push(`error=${formatEventValue(record.error)}`);
  return parts.filter(Boolean).join(" ");
}

function summarizeToolEvent(record: Record<string, unknown>): string {
  const args = objectField(record, "args");
  const phase = String(record.type ?? "").replace("tool_execution_", "");
  const parts = [humanToolName(record.name), phase];
  if (record.route) parts.push(`route=${formatEventValue(record.route)}`);
  if (record.source) parts.push(`source=${formatEventValue(record.source)}`);
  if (record.turnId !== undefined) parts.push(`turn=${formatEventValue(record.turnId)}`);
  if (args) parts.push(summarizeArgs(args));
  if (record.durationMs !== undefined) parts.push(`duration=${formatDuration(record.durationMs)}`);
  const error = stringField(record, "errorMessage");
  if (error) {
    parts.push(`error=${formatEventValue(error)}`);
  } else {
    const text = stringField(record, "text");
    if (text && text !== "Tool started" && text !== "Retrying tool") parts.push(`text=${formatEventValue(text)}`);
  }
  return parts.filter(Boolean).join(" ");
}

function formatToolConversationText(payload: Record<string, unknown>): string {
  const tool = humanToolName(payload.name);
  const args = objectField(payload, "args");
  const action = args ? stringField(args, "action") : "";
  const query = args ? stringField(args, "query") || stringField(args, "app") || stringField(args, "url") : "";
  const details = [action, query].filter(Boolean).join(": ");
  return details ? `${tool} started (${details}).` : `${tool} started.`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = ["action", "query", "kind", "prefer", "uri", "deviceName", "percent", "state", "app", "url", "location", "expression", "time", "label"];
  const parts = keys
    .filter((key) => args[key] !== undefined && args[key] !== null && args[key] !== "")
    .map((key) => `${key}=${formatEventValue(args[key])}`);
  return parts.length ? parts.join(" ") : `args=${formatEventValue(args)}`;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function formatDuration(value: unknown): string {
  const duration = Number(value);
  return Number.isFinite(duration) ? `${Math.round(duration)}ms` : String(value);
}

function formatEventValue(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const text = raw.length > 96 ? `${raw.slice(0, 93)}...` : raw;
  return /\s/.test(text) ? `"${text}"` : text;
}

function humanToolName(value: unknown): string {
  const name = String(value ?? "tool");
  return name
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Tool";
}

function fullEventPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/** The Gemma model actually serving requests, honoring provider and low-resource mode. */
function activeModel(config: AppConfig | null | undefined): string {
  if (config?.openrouter?.enabled) {
    return config.openrouter.model ?? "google/gemma-4-31b-it:free";
  }
  if (config?.python?.lowResourceMode && config.ollama?.lowResourceModel) {
    return config.ollama.lowResourceModel;
  }
  return config?.ollama?.model ?? "gemma4:12b";
}

function brainSummary(config: AppConfig | null | undefined): string {
  const model = activeModel(config);
  if (config?.openrouter?.enabled) {
    return `Gemma · ${model} (OpenRouter)`;
  }
  return `Gemma · ${model} (local)`;
}

function formatRuntimeSummary(config: AppConfig, status: PiStatus | null): string {
  const model = activeModel(config);
  if (config.openrouter?.enabled) {
    if (config.pi?.enabled && status?.available) return `OpenRouter ${model} + Pi tools`;
    return `OpenRouter ${model}`;
  }
  if (config.pi?.enabled && status?.available) return `Gemma ${model} + Pi tools`;
  return `Gemma ${model} (local)`;
}

function formatPiStatus(status: PiStatus | null): string {
  if (!status) return "Checking";
  if (!status.enabled) return "Disabled";
  if (!status.available) return status.reason ?? "Not found";
  if (status.running) return "Running";
  return "Available";
}

function formatPiCommand(config: AppConfig | null): string {
  if (!config) return "Unknown";
  return [config.pi.command, ...config.pi.args].join(" ");
}
