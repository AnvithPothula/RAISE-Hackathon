import { Activity, Mic, MicOff, Radio, Save, Send, Settings, Square, Trash2, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig, AssistantState, ConversationItem, PiEvent, PiStatus, WorkerEvent } from "../shared/types";

const nowId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
type VoiceAction = "wakeword" | "mic";
type NodeStatus = "idle" | "listening" | "thinking" | "speaking" | "error";
type ConnectedNode = {
  id: string;
  label: string;
  status: NodeStatus;
  lastSeen: number;
};

export function App() {
  const [state, setState] = useState<AssistantState>("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [conversation, setConversation] = useState<ConversationItem[]>([]);
  const [toolEvents, setToolEvents] = useState<PiEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [configSummary, setConfigSummary] = useState("llama3:8b");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingVoiceAction, setPendingVoiceAction] = useState<VoiceAction | null>(null);
  const [wakeSessionArmed, setWakeSessionArmed] = useState(false);
  const [piStatus, setPiStatus] = useState<PiStatus | null>(null);
  const [typedPrompt, setTypedPrompt] = useState("");
  const [connectedNodes, setConnectedNodes] = useState<ConnectedNode[]>([]);
  const [toolFlashActive, setToolFlashActive] = useState(false);
  const toolFlashTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!window.pythos) {
      setError("Electron preload bridge did not load. Rebuild and restart the app.");
      setState("error");
      return;
    }

    window.pythos.getConfig().then((config) => {
      setConfig(config);
      setSettingsDraft(config);
      setConfigSummary(formatRuntimeSummary(config, piStatus));
    }).catch((reason: unknown) => {
      setError(`Config load failed: ${String(reason)}`);
      setState("error");
    });

    window.pythos.getPiStatus().then((status) => {
      setPiStatus(status);
    }).catch((reason: unknown) => {
      setPiStatus({
        enabled: false,
        available: false,
        running: false,
        command: null,
        args: [],
        reason: `Pi status failed: ${String(reason)}`
      });
    });

    const offWorker = window.pythos.onWorkerEvent(handleWorkerEvent);
    const offPi = window.pythos.onPiEvent(handlePiEvent);
    const offPiStatus = window.pythos.onPiStatus((status) => setPiStatus(status));
    const offState = window.pythos.onAssistantState((next) => setState(next as AssistantState));

    return () => {
      offWorker();
      offPi();
      offPiStatus();
      offState();
      if (toolFlashTimer.current !== null) {
        window.clearTimeout(toolFlashTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (config) {
      setConfigSummary(formatRuntimeSummary(config, piStatus));
    }
  }, [config, piStatus]);

  function handleWorkerEvent(event: WorkerEvent) {
    if (event.type === "state") {
      setState(event.payload.value);
      if (event.payload.value !== "loading") {
        setPendingVoiceAction(null);
      }
      if (event.payload.value === "idle" || event.payload.value === "error" || event.payload.value === "shutdown") {
        setWakeSessionArmed(false);
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
      setConversation((items) => [
        ...items,
        { id: nowId(), role: "user", text: event.payload.text, timestamp: Date.now() }
      ]);
      setState("thinking");
      return;
    }
    if (event.type === "tts_started") {
      setState("speaking");
      return;
    }
    if (event.type === "tts_done") {
      setState((current) => (current === "thinking" ? current : "idle"));
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
        if (state === "error") {
          setState("thinking");
        }
      }
      if (type === "message_update" || type === "message_end") {
        const text = extractAssistantText(payload);
        if (text) {
          setError(null);
          setConversation((items) => upsertAssistant(items, text));
        }
      }
      if (type === "tool_execution_start") {
        triggerToolFlash();
        setConversation((items) => [
          ...items,
          { id: nowId(), role: "tool", text: formatToolConversationText(payload), timestamp: Date.now() }
        ]);
      }
      if (type === "turn_end") {
        setState("idle");
      }
    }
  }

  function triggerToolFlash() {
    if (toolFlashTimer.current !== null) {
      window.clearTimeout(toolFlashTimer.current);
    }
    setToolFlashActive(true);
    toolFlashTimer.current = window.setTimeout(() => {
      setToolFlashActive(false);
      toolFlashTimer.current = null;
    }, 500);
  }

  const statusText = useMemo(() => {
    if (state === "idle") return "Ready";
    if (state === "loading") return "Loading audio";
    if (state === "wakeword") return `Say ${String(config?.audio?.wakeWord ?? "pythos")}`;
    if (state === "listening") return partial || "Listening";
    if (state === "thinking") return "Thinking";
    if (state === "speaking") return "Speaking";
    if (state === "error") return "Needs attention";
    return "Stopped";
  }, [partial, state]);

  const toggleWakeword = () => {
    if (!window.pythos) {
      setError("Electron preload bridge is unavailable.");
      setState("error");
      return;
    }
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
  };

  const toggleMic = () => {
    if (!window.pythos) {
      setError("Electron preload bridge is unavailable.");
      setState("error");
      return;
    }
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
  };

  const stopAll = () => {
    if (!window.pythos) {
      setError("Electron preload bridge is unavailable.");
      setState("error");
      return;
    }
    window.pythos.stopListening();
    window.pythos.stopSpeaking();
    window.pythos.abortPi();
    setWakeSessionArmed(false);
    setPendingVoiceAction(null);
    setState("idle");
  };

  const submitTypedPrompt = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!window.pythos) {
      setError("Electron preload bridge is unavailable.");
      setState("error");
      return;
    }
    const prompt = typedPrompt.trim();
    if (!prompt) {
      return;
    }
    setTypedPrompt("");
    setError(null);
    setWakeSessionArmed(false);
    setPendingVoiceAction(null);
    setConversation((items) => [...items, { id: nowId(), role: "user", text: prompt, timestamp: Date.now() }]);
    setState("thinking");
    window.pythos.promptAssistant(prompt).catch((reason: unknown) => {
      setError(`Typed prompt failed: ${String(reason)}`);
      setState("error");
    });
  };

  const openSettings = () => {
    setSettingsDraft(config ? structuredClone(config) : null);
    setSettingsOpen(true);
  };

  const saveSettings = async () => {
    if (!settingsDraft || !window.pythos) {
      return;
    }
    const saved = await window.pythos.saveConfig(settingsDraft);
    const nextPiStatus = await window.pythos.getPiStatus();
    setConfig(saved);
    setSettingsDraft(structuredClone(saved));
    setPiStatus(nextPiStatus);
    setConfigSummary(formatRuntimeSummary(saved, nextPiStatus));
    setSettingsOpen(false);
    setError(null);
  };

  return (
    <main className="app-shell">
      <section className="stage">
        <header className="topbar">
          <div>
            <p className="eyebrow">Pythos v3</p>
            <h1>{statusText}</h1>
          </div>
          <div className="status-pill">
            <Activity size={16} />
            {configSummary}
          </div>
        </header>

        <div
          className={`orb-wrap ${state}${toolFlashActive ? " tool-flash" : ""}`}
          style={{ "--level": audioLevel } as React.CSSProperties}
        >
          <div className="orb-glow" />
          <div className="node-orbits" aria-label="Connected nodes">
            {connectedNodes.map((node, index) => (
              <NodeOrbit node={node} index={index} count={connectedNodes.length} key={node.id} />
            ))}
          </div>
          <div className="orb">
            <div className="orb-core" />
            <div className="pulse-ring one" />
            <div className="pulse-ring two" />
          </div>
        </div>

        <div className="controls" aria-label="Voice controls">
          <button
            className={voiceButtonClass("wakeword", wakeSessionArmed || state === "wakeword", pendingVoiceAction)}
            onClick={toggleWakeword}
            title={wakeSessionArmed || state === "wakeword" ? "Stop wake word" : "Arm wake word"}
            aria-pressed={wakeSessionArmed || state === "wakeword"}
            data-label="Wake"
          >
            <Radio />
          </button>
          <button
            className={voiceButtonClass("mic", state === "listening", pendingVoiceAction)}
            onClick={toggleMic}
            title={state === "listening" ? "Stop listening" : "Start push to talk"}
            aria-pressed={state === "listening"}
            data-label="Talk"
          >
            {state === "listening" ? <MicOff /> : <Mic />}
          </button>
          <button className="icon-button" onClick={stopAll} title="Stop current work">
            <Square />
          </button>
          <button
            className="icon-button"
            onClick={() => {
              setConversation([]);
              window.pythos?.clearAssistantContext();
            }}
            title="Clear transcript and context"
          >
            <Trash2 />
          </button>
          <button className="icon-button" onClick={() => window.pythos?.getPiCommands()} title="Refresh Pi tools">
            <Wrench />
          </button>
          <button className="icon-button" onClick={openSettings} title="Settings">
            <Settings />
          </button>
        </div>

        <form className="text-prompt" onSubmit={submitTypedPrompt}>
          <input
            value={typedPrompt}
            onChange={(event) => setTypedPrompt(event.target.value)}
            placeholder="Type to Pythos"
            aria-label="Type a prompt"
          />
          <button className="text-send" type="submit" title="Send typed prompt" disabled={!typedPrompt.trim()}>
            <Send size={18} />
          </button>
        </form>

        {error && <div className="error-banner">{error}</div>}
      </section>

      <aside className="side-panel">
        <section className="panel-section">
          <h2>Conversation</h2>
          <div className="conversation-list">
            {conversation.length === 0 ? (
              <p className="muted">No transcript yet.</p>
            ) : (
              conversation.map((item) => (
                <article className={`message ${item.role}`} key={item.id}>
                  <span>{item.role}</span>
                  <p>{item.text}</p>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="panel-section">
          <h2>Tool Timeline</h2>
          <div className="tool-list">
            {toolEvents.length === 0 ? (
              <p className="muted">Pi events will appear here.</p>
            ) : (
              toolEvents.map((event, index) => (
                <article className="tool-event" key={`${event.type}-${index}`}>
                  <span>{labelEvent(event)}</span>
                  <code title={fullEventPayload(event.payload)}>{summarizeEvent(event.payload)}</code>
                </article>
              ))
            )}
          </div>
        </section>
      </aside>

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSettingsOpen(false)}>
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="settings-header">
              <div>
                <p className="eyebrow">Runtime</p>
                <h2>Settings</h2>
              </div>
              <button className="text-button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </header>

            <div className="settings-grid">
              <Setting label="Assistant state" value={state} />
              <Setting label="Pi status" value={formatPiStatus(piStatus)} />
              <SettingInput
                label="Ollama model"
                value={settingsDraft?.ollama.model ?? ""}
                onChange={(value) => updateDraft(setSettingsDraft, ["ollama", "model"], value)}
              />
              <SettingInput
                label="Ollama URL"
                value={settingsDraft?.ollama.baseUrl ?? ""}
                onChange={(value) => updateDraft(setSettingsDraft, ["ollama", "baseUrl"], value)}
              />
              <SettingSelect
                label="Thinking level"
                value={settingsDraft?.ollama.think ?? "null"}
                options={[
                  { label: "Off / unsupported", value: "null" },
                  { label: "Low", value: "low" },
                  { label: "Medium", value: "medium" },
                  { label: "High", value: "high" }
                ]}
                onChange={(value) => updateDraft(setSettingsDraft, ["ollama", "think"], value === "null" ? null : value)}
              />
              <SettingInput
                label="Spotify client ID"
                value={settingsDraft?.spotify?.clientId ?? ""}
                onChange={(value) => updateDraft(setSettingsDraft, ["spotify", "clientId"], value)}
              />
              <SettingInput
                label="Spotify redirect URI"
                value={settingsDraft?.spotify?.redirectUri ?? "http://127.0.0.1:8888/callback"}
                onChange={(value) => updateDraft(setSettingsDraft, ["spotify", "redirectUri"], value)}
              />
              <SettingToggle
                label="Low resource mode"
                checked={Boolean(settingsDraft?.python?.lowResourceMode)}
                onChange={(value) => updateDraft(setSettingsDraft, ["python", "lowResourceMode"], value)}
              />
              <SettingToggle
                label="Experimental Pi tools"
                checked={Boolean(settingsDraft?.pi?.enabled)}
                onChange={(value) => updateDraft(setSettingsDraft, ["pi", "enabled"], value)}
              />
              <SettingInput
                label="Wake word"
                value={String(settingsDraft?.audio?.wakeWord ?? "")}
                onChange={(value) => updateDraft(setSettingsDraft, ["audio", "wakeWord"], value)}
              />
              <SettingNumber
                label="Wake threshold"
                value={Number(settingsDraft?.audio?.wakeThreshold ?? 0.5)}
                min={0.1}
                max={0.95}
                step={0.05}
                onChange={(value) => updateDraft(setSettingsDraft, ["audio", "wakeThreshold"], value)}
              />
              <SettingNumber
                label="Speech speed"
                value={Number(settingsDraft?.audio?.ttsLengthScale ?? 0.8)}
                min={0.5}
                max={1.6}
                step={0.05}
                onChange={(value) => updateDraft(setSettingsDraft, ["audio", "ttsLengthScale"], value)}
                hint="Lower is faster"
              />
              <SettingNumber
                label="ASR timeout"
                value={Number(settingsDraft?.audio?.asrTimeoutSeconds ?? 10)}
                min={3}
                max={30}
                step={1}
                onChange={(value) => updateDraft(setSettingsDraft, ["audio", "asrTimeoutSeconds"], value)}
              />
              <SettingNumber
                label="Silence timeout"
                value={Number(settingsDraft?.audio?.silenceTimeoutSeconds ?? 3)}
                min={1}
                max={10}
                step={0.5}
                onChange={(value) => updateDraft(setSettingsDraft, ["audio", "silenceTimeoutSeconds"], value)}
              />
            </div>

            <div className="settings-actions">
              <span>{formatPiCommand(settingsDraft ?? config)}</span>
              <button className="text-button save" onClick={saveSettings}>
                <Save size={16} />
                Save
              </button>
            </div>

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
          </section>
        </div>
      )}
    </main>
  );
}

function NodeOrbit({ node, index, count }: { node: ConnectedNode; index: number; count: number }) {
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
      <div className="node-anchor">
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
  if (active) {
    classes.push("active");
  }
  if (pending === action) {
    classes.push("loading");
  }
  return classes.join(" ");
}

function SettingInput({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="setting-row editable">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
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
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
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
        <input
          type="range"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
      {hint && <small>{hint}</small>}
    </label>
  );
}

function SettingToggle({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
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
    if (!current) {
      return current;
    }
    const next = structuredClone(current) as AppConfig;
    const nextRecord = next as unknown as Record<keyof AppConfig, unknown>;
    const existingGroup = nextRecord[path[0]];
    const group =
      existingGroup && typeof existingGroup === "object" && !Array.isArray(existingGroup)
        ? (existingGroup as Record<string, unknown>)
        : {};
    nextRecord[path[0]] = group;
    group[path[1]] = value;
    return next;
  });
}

function extractAssistantText(payload: Record<string, unknown>): string {
  const text = payload.text ?? payload.content ?? payload.message;
  if (typeof text === "string") {
    return text;
  }
  return "";
}

function upsertAssistant(items: ConversationItem[], text: string): ConversationItem[] {
  const last = items.at(-1);
  if (last?.role === "assistant") {
    return [...items.slice(0, -1), { ...last, text }];
  }
  return [...items, { id: nowId(), role: "assistant", text, timestamp: Date.now() }];
}

function updateConnectedNodes(nodes: ConnectedNode[], event: PiEvent): ConnectedNode[] {
  const echoEvent = extractEchoEvent(event);
  if (!echoEvent) {
    return nodes;
  }
  const payload = echoEvent.payload;
  if (!payload || typeof payload !== "object") {
    return nodes;
  }
  const record = payload as Record<string, unknown>;
  const deviceId = typeof record.deviceId === "string" && record.deviceId.trim() ? record.deviceId.trim() : "";
  if (!deviceId) {
    return nodes;
  }
  const eventType = String(record.type ?? echoEvent.type);
  if (eventType === "offline" || eventType === "disconnected") {
    return nodes.filter((node) => node.id !== deviceId);
  }
  const existingIndex = nodes.findIndex((node) => node.id === deviceId);
  const existingNode = existingIndex >= 0 ? nodes[existingIndex] : null;
  if (echoEvent.type === "realtime_state" && !existingNode) {
    return nodes;
  }
  const label = extractNodeLabel(record, deviceId, existingNode?.label);
  const status =
    eventType === "audio_level" && existingNode
      ? existingNode.status
      : deriveNodeStatus(echoEvent.type, eventType, record);
  const nextNode: ConnectedNode = { id: deviceId, label, status, lastSeen: Date.now() };
  const nextNodes =
    existingIndex >= 0
      ? nodes.map((node, index) => (index === existingIndex ? { ...node, ...nextNode } : node))
      : [...nodes, nextNode];

  return nextNodes.sort((left, right) => right.lastSeen - left.lastSeen).slice(0, 8);
}

function extractEchoEvent(event: PiEvent): { type: string; payload: unknown } | null {
  if (event.type !== "echo" || !event.payload || typeof event.payload !== "object") {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.type !== "string") {
    return null;
  }
  return { type: payload.type, payload: payload.payload };
}

function extractNodeLabel(record: Record<string, unknown>, deviceId: string, fallbackLabel?: string): string {
  const candidates = [record.deviceName, record.name, record.label, record.friendlyName];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().slice(0, 24);
    }
  }
  if (fallbackLabel) {
    return fallbackLabel;
  }
  if (/echo|alexa/i.test(deviceId)) {
    return "Alexa";
  }
  return deviceId.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).slice(0, 24);
}

function deriveNodeStatus(
  echoType: string,
  eventType: string,
  record: Record<string, unknown>
): NodeStatus {
  if (echoType === "error" || eventType === "error") {
    return "error";
  }
  const value = typeof record.value === "string" ? record.value : "";
  if (eventType === "listening" || eventType === "wake" || value === "listening" || value === "wakeword") {
    return "listening";
  }
  if (echoType === "upload_started" || echoType === "transcript" || eventType === "final_transcript") {
    return "thinking";
  }
  if (echoType === "reply" || eventType === "tts_play_requested" || eventType === "play_audio") {
    return "speaking";
  }
  if (eventType === "idle" || eventType === "online" || eventType === "status" || eventType === "heartbeat") {
    return "idle";
  }
  if (echoType === "realtime_state" && value === "thinking") {
    return "thinking";
  }
  return "idle";
}

function formatNodeStatus(status: NodeStatus): string {
  if (status === "idle") return "Idle";
  if (status === "listening") return "Listening";
  if (status === "thinking") return "Thinking";
  if (status === "speaking") return "Speaking";
  return "Error";
}

function summarizeEvent(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.slice(0, 160);
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const type = String(record.type ?? "");
    if (type === "debug") {
      return summarizeDebugEvent(record);
    }
    if (type === "tool_execution_start" || type === "tool_execution_end" || type === "tool_execution_error") {
      return summarizeToolEvent(record);
    }
    if (typeof record.text === "string") {
      return record.text.slice(0, 220);
    }
    if (typeof record.errorMessage === "string") {
      return record.errorMessage.slice(0, 220);
    }
    if (typeof record.code === "number" || record.code === null) {
      if (record.code === 4294967295) {
        return "Pi process exited. Direct Ollama fallback will handle active requests.";
      }
      return `Process exited with code ${String(record.code ?? "unknown")}`;
    }
    const message = record.message as Record<string, unknown> | undefined;
    if (typeof message?.errorMessage === "string") {
      return message.errorMessage.slice(0, 220);
    }
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim().slice(0, 220);
  }
  return JSON.stringify(payload).slice(0, 220);
}

function labelEvent(event: PiEvent): string {
  const payload = event.payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const type = String(record.type ?? event.type);
    if (type === "status") {
      return "Status";
    }
    if (type === "debug") {
      return "Debug";
    }
    if (type === "message_end") {
      return event.type === "ollama-fallback" ? "Ollama Fallback" : "Assistant";
    }
    if (type === "tool_execution_start") {
      return `Tool Started - ${humanToolName(record.name)}`;
    }
    if (type === "tool_execution_end") {
      return `Tool Finished - ${humanToolName(record.name)}`;
    }
    if (type === "tool_execution_error") {
      return `Tool Failed - ${humanToolName(record.name)}`;
    }
    if (type === "agent_start") {
      return "Pi Started";
    }
    if (type === "agent_end") {
      return "Pi Finished";
    }
  }
  if (event.type === "exit") {
    return "Pi Exit";
  }
  if (event.type === "stderr") {
    return "Pi Log";
  }
  return event.type;
}

function summarizeDebugEvent(record: Record<string, unknown>): string {
  const text = stringField(record, "text") || "Debug event";
  const parts = [text];
  for (const key of ["turnId", "source", "route", "tool", "reason", "model", "promptChars", "chars", "toolUsed"]) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      parts.push(`${key}=${formatEventValue(record[key])}`);
    }
  }
  if (typeof record.prompt === "string") {
    parts.push(`prompt=${formatEventValue(record.prompt)}`);
  }
  if (record.args && typeof record.args === "object") {
    parts.push(summarizeArgs(record.args as Record<string, unknown>));
  }
  if (typeof record.error === "string") {
    parts.push(`error=${formatEventValue(record.error)}`);
  }
  return parts.filter(Boolean).join(" ");
}

function summarizeToolEvent(record: Record<string, unknown>): string {
  const args = objectField(record, "args");
  const phase = String(record.type ?? "").replace("tool_execution_", "");
  const parts = [humanToolName(record.name), phase];
  if (record.route) {
    parts.push(`route=${formatEventValue(record.route)}`);
  }
  if (record.source) {
    parts.push(`source=${formatEventValue(record.source)}`);
  }
  if (record.turnId !== undefined) {
    parts.push(`turn=${formatEventValue(record.turnId)}`);
  }
  if (args) {
    parts.push(summarizeArgs(args));
  }
  if (record.durationMs !== undefined) {
    parts.push(`duration=${formatDuration(record.durationMs)}`);
  }
  const error = stringField(record, "errorMessage");
  if (error) {
    parts.push(`error=${formatEventValue(error)}`);
  } else {
    const text = stringField(record, "text");
    if (text && text !== "Tool started" && text !== "Retrying tool") {
      parts.push(`text=${formatEventValue(text)}`);
    }
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
  const keys = [
    "action",
    "query",
    "kind",
    "prefer",
    "uri",
    "deviceName",
    "percent",
    "state",
    "app",
    "url",
    "location",
    "expression",
    "time",
    "label"
  ];
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
  if (typeof payload === "string") {
    return payload;
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function formatRuntimeSummary(config: AppConfig, status: PiStatus | null): string {
  if (config.pi.enabled && status?.available) {
    return `${config.ollama.model} direct + Pi tools`;
  }
  return `${config.ollama.model} direct`;
}

function formatPiStatus(status: PiStatus | null): string {
  if (!status) {
    return "Checking";
  }
  if (!status.enabled) {
    return "Disabled";
  }
  if (!status.available) {
    return status.reason ?? "Not found";
  }
  if (status.running) {
    return "Available and running";
  }
  return "Available, starts on demand";
}

function formatPiCommand(config: AppConfig | null): string {
  if (!config) {
    return "Unknown";
  }
  return [config.pi.command, ...config.pi.args].join(" ");
}
