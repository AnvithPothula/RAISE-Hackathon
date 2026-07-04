import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectInstantInvocations,
  promptNeedsMultiToolLoop,
  routeUserIntent,
  resolveContextualLocalTool as resolveContextualFromRouter
} from "./intentRouter.js";
import { extractLocationFromPrompt, cleanLocation } from "./locationUtils.js";
import { normalizeMathExpression } from "./mathExpression.js";

export { extractLocationFromPrompt, cleanLocation } from "./locationUtils.js";
import { cleanAppTarget, normalizeVoiceTranscript } from "./voiceTranscript.js";
import { runSkillScript, type SkillScriptArgs, type SkillScriptResult } from "./skillRegistry.js";
import type { UserMemoryService } from "./userMemory.js";

export type LocalToolResult = {
  name:
    | "weather"
    | "time"
    | "calculator"
    | "skill_script"
    | "alarm"
    | "open_app"
    | "open_website"
    | "web_search"
    | "screen"
    | "sub_agent"
    | "deep_research"
    | "run_code"
    | "cursor_agent"
    | "memory"
    | "capabilities"
    | "clipboard"
    | "list_folder"
    | "spotify";
  text: string;
  location?: string;
  skillName?: string;
  script?: string;
  url?: string;
  query?: string;
  fetchedAt?: string;
  path?: string;
  results?: WebSearchResult[];
  /** Present on open_app when launch verification failed. */
  opened?: boolean;
};

export type AppOpenOutcome = {
  opened: boolean;
  detail?: string;
};

export type LocalToolName = LocalToolResult["name"];
export type LocalToolInvocation = {
  name: LocalToolName;
  args: LocalToolArgs;
};
export type LocalToolServices = {
  captureScreen?: () => Promise<{ path: string; width: number; height: number }>;
  analyzeScreen?: (path: string, prompt: string) => Promise<string>;
  openApp?: (app: string) => Promise<AppOpenOutcome | void>;
  openWebsite?: (url: string) => Promise<void>;
  onAlarm?: (alarm: AlarmItem) => void;
  fetch?: FetchService;
  geocode?: GeocodeService;
  forecast?: ForecastService;
  webSearch?: WebSearchService;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (timeout: TimerHandle) => void;
  userMemory?: UserMemoryService;
  runSkillScript?: SkillScriptRunner;
  spotify?: SpotifyToolConfig;
};

export type LocalToolArgs = {
  location?: string | null;
  expression?: string | null;
  action?: string | null;
  time?: string | null;
  label?: string | null;
  id?: string | null;
  app?: string | null;
  url?: string | null;
  query?: string | null;
  path?: string | null;
  task?: string | null;
  text?: string | null;
  category?: string | null;
  source?: string | null;
  kind?: string | null;
  prefer?: string | null;
  uri?: string | null;
  deviceName?: string | null;
  percent?: number | string | null;
  state?: boolean | string | null;
  language?: string | null;
  code?: string | null;
  description?: string | null;
} & SkillScriptArgs;

type AlarmItem = {
  id: string;
  dueAt: number;
  label: string;
};

type SpotifyPreflightResult =
  | { ok: true }
  | { ok: false; recoverable: boolean; message: string };

export type FetchService = (url: URL, init?: RequestInit) => Promise<Response>;
export type SkillScriptRunner = (args: SkillScriptArgs) => Promise<SkillScriptResult>;
export type SpotifyToolConfig = {
  clientId?: string;
  redirectUri?: string;
  tokenCache?: string;
};
type TimerHandle = ReturnType<typeof setTimeout>;

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type GeocodedPlace = {
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  population?: number;
};

export type WeatherForecast = {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  timezone?: string;
};

export type GeocodeService = (location: string) => Promise<GeocodedPlace>;
export type ForecastService = (place: GeocodedPlace) => Promise<WeatherForecast>;
export type WebSearchService = (query: string) => Promise<{ results: WebSearchResult[]; fetchedAt?: string }>;

type GeocodeResult = {
  results?: Array<{
    name: string;
    admin1?: string;
    country?: string;
    latitude: number;
    longitude: number;
    timezone?: string;
    population?: number;
  }>;
};

const alarms = new Map<string, AlarmItem & { timeout: TimerHandle }>();

const WINDOWS_APP_ALIASES: Record<string, string> = {
  calculator: "calc.exe",
  calc: "calc.exe",
  settings: "ms-settings:",
  "windows settings": "ms-settings:",
  notepad: "notepad.exe",
  notes: "notepad.exe",
  paint: "ms-paint:",
  "ms paint": "ms-paint:",
  "microsoft paint": "ms-paint:",
  explorer: "explorer.exe",
  "file explorer": "explorer.exe",
  files: "explorer.exe",
  chrome: "chrome.exe",
  edge: "msedge.exe",
  word: "winword.exe",
  "microsoft word": "winword.exe",
  excel: "excel.exe",
  "microsoft excel": "excel.exe",
  powerpoint: "powerpnt.exe",
  "microsoft powerpoint": "powerpnt.exe",
  browser: "msedge.exe",
  "default browser": "msedge.exe",
  cmd: "cmd.exe",
  "command prompt": "cmd.exe",
  powershell: "powershell.exe",
  terminal: "wt.exe",
  spotify: "spotify.exe",
  "github desktop": "GitHubDesktop.exe"
};

const MAC_APP_ALIASES: Record<string, string> = {
  calculator: "Calculator",
  calc: "Calculator",
  settings: "System Settings",
  "system settings": "System Settings",
  "system preferences": "System Settings",
  notepad: "TextEdit",
  textedit: "TextEdit",
  notes: "Notes",
  paint: "Preview",
  preview: "Preview",
  explorer: "Finder",
  "file explorer": "Finder",
  finder: "Finder",
  files: "Finder",
  chrome: "Google Chrome",
  "google chrome": "Google Chrome",
  safari: "Safari",
  edge: "Microsoft Edge",
  "microsoft edge": "Microsoft Edge",
  word: "Microsoft Word",
  "microsoft word": "Microsoft Word",
  excel: "Microsoft Excel",
  "microsoft excel": "Microsoft Excel",
  powerpoint: "Microsoft PowerPoint",
  "microsoft powerpoint": "Microsoft PowerPoint",
  browser: "Safari",
  "default browser": "Safari",
  terminal: "Terminal",
  spotify: "Spotify",
  discord: "Discord",
  slack: "Slack",
  zoom: "zoom.us",
  teams: "Microsoft Teams",
  "microsoft teams": "Microsoft Teams",
  vscode: "Visual Studio Code",
  "visual studio code": "Visual Studio Code",
  cursor: "Cursor",
  xcode: "Xcode",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  obs: "OBS",
  docker: "Docker",
  music: "Music",
  mail: "Mail",
  calendar: "Calendar",
  messages: "Messages",
  photos: "Photos",
  "github desktop": "GitHub Desktop",
  "app store": "App Store",
  "activity monitor": "Activity Monitor"
};

const LINUX_APP_ALIASES: Record<string, string> = {
  calculator: "gnome-calculator",
  calc: "gnome-calculator",
  settings: "gnome-control-center",
  "system settings": "gnome-control-center",
  notepad: "gedit",
  notes: "gedit",
  editor: "gedit",
  files: "nautilus",
  "file explorer": "nautilus",
  explorer: "nautilus",
  chrome: "google-chrome",
  "google chrome": "google-chrome",
  firefox: "firefox",
  browser: "xdg-open:https://",
  terminal: "gnome-terminal",
  spotify: "spotify"
};

const APP_ALIASES: Record<string, string> =
  process.platform === "darwin"
    ? MAC_APP_ALIASES
    : process.platform === "win32"
      ? WINDOWS_APP_ALIASES
      : LINUX_APP_ALIASES;

const WEBSITE_ALIASES: Record<string, string> = {
  google: "google.com",
  youtube: "youtube.com",
  gmail: "mail.google.com",
  maps: "maps.google.com",
  reddit: "reddit.com",
  github: "github.com",
  amazon: "amazon.com",
  facebook: "facebook.com",
  instagram: "instagram.com",
  x: "x.com",
  twitter: "x.com"
};

/** Known site names — opening these defaults to the browser unless the user asks for the app. */
export function websiteAliasForName(name: string): string | null {
  const normalized = String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return WEBSITE_ALIASES[normalized] ?? null;
}

export function isOpenAppFailure(result: LocalToolResult): boolean {
  return result.name === "open_app" && result.opened === false;
}

export function openAppFailureMessage(result: LocalToolResult): string {
  return result.text || "I couldn't open that application.";
}

export function extractUserLocation(prompt: string): string | null {
  const match = prompt.match(/\b(?:i am|i'm|im|i live|i live in|my location is|set location to)\s+(?:in\s+)?([a-z][a-z\s,.-]{2,})$/i);
  return cleanLocation(match?.[1] ?? "");
}

export async function runLocalTool(
  prompt: string,
  knownLocation: string | null,
  services: LocalToolServices = {}
): Promise<LocalToolResult | null> {
  const normalized = prompt.toLowerCase();
  if (/\b(weather|forecast|temperature|temp|rain|snow|wind)\b/.test(normalized)) {
    return getWeather(prompt, knownLocation, services);
  }
  if (/\b(time|date|day)\b/.test(normalized) && /\b(what|current|now|today|tonight|tomorrow|date|time)\b/.test(normalized)) {
    return getTime(prompt, knownLocation, services);
  }
  return null;
}

export function resolveDirectLocalTools(
  prompt: string,
  context: { previousToolName?: LocalToolName | null; knownLocation?: string | null } = {}
): LocalToolInvocation[] {
  const compound = collectInstantInvocations(prompt, context).map(normalizeOpenAppInvocation);
  if (compound.length >= 2) {
    return compound;
  }
  if (compound.length === 1 && !promptNeedsMultiToolLoop(prompt)) {
    return compound;
  }

  const decision = routeUserIntent(prompt, context);
  if (decision.invocation) {
    return [normalizeOpenAppInvocation(decision.invocation)];
  }

  const cleanPrompt = cleanDirectPrompt(prompt);
  const spotifyInvocation = resolveDirectSpotifyTool(cleanPrompt);
  if (spotifyInvocation) {
    return [spotifyInvocation];
  }

  return [];
}

export function resolveDirectLocalTool(
  prompt: string,
  context: { previousToolName?: LocalToolName | null; knownLocation?: string | null } = {}
): LocalToolInvocation | null {
  const invocations = resolveDirectLocalTools(prompt, context);
  return invocations[0] ?? null;
}

function normalizeOpenAppInvocation(invocation: LocalToolInvocation): LocalToolInvocation {
  if (invocation.name !== "open_app") {
    return invocation;
  }
  const raw = String(invocation.args.app ?? invocation.args.query ?? "").trim();
  if (!raw) {
    return invocation;
  }
  return { ...invocation, args: { ...invocation.args, app: normalizeAppName(cleanAppTarget(raw)) } };
}

export function resolveContextualLocalTool(
  prompt: string,
  previousToolName: LocalToolName | null | undefined,
  knownLocation?: string | null
): LocalToolInvocation | null {
  const contextual = resolveContextualFromRouter(prompt, previousToolName, knownLocation);
  if (contextual) {
    return contextual;
  }
  const cleanPrompt = cleanDirectPrompt(prompt);
  if (previousToolName === "spotify") {
    return resolveContextualSpotifyTool(cleanPrompt);
  }
  return null;
}

function cleanDirectPrompt(prompt: string): string {
  return String(prompt ?? "")
    .trim()
    .replace(/[.!?]+$/g, "")
    .replace(/^(?:hey\s+)?pythos[,:\s]+/i, "")
    .trim();
}

export async function runNamedLocalTool(
  name: LocalToolName,
  args: LocalToolArgs,
  knownLocation: string | null,
  services: LocalToolServices = {}
): Promise<LocalToolResult> {
  if (name === "skill_script") {
    return runConfiguredSkillScript(args, services);
  }

  if (name === "calculator") {
    return calculate(args.expression ?? "");
  }

  if (name === "alarm") {
    return manageAlarm(args, services);
  }

  if (name === "open_app") {
    return openApp(args.app ?? args.query ?? "", services);
  }

  if (name === "open_website") {
    return openWebsite(args.url ?? args.query ?? "", services);
  }

  if (name === "web_search") {
    return webSearch(args.query ?? "", services);
  }

  if (name === "run_code") {
    return runCodeTool(args);
  }

  if (name === "cursor_agent") {
    return runCursorAgentTool(args);
  }

  if (name === "screen") {
    return inspectScreen(args, services);
  }

  if (name === "memory") {
    return manageUserMemory(args, services);
  }

  if (name === "spotify") {
    return runSpotifyTool(args, services);
  }

  if (name === "capabilities") {
    return describeCapabilities();
  }

  if (name === "clipboard") {
    return readClipboard();
  }

  if (name === "list_folder") {
    return listFolder(args.path ?? args.query ?? "");
  }

  const requestedLocation = cleanLocation(args.location ?? "");
  const fallbackLocation = knownLocation ?? "Eagan, Minnesota";
  const location = requestedLocation ?? fallbackLocation;
  if (name === "weather") {
    return requestedLocation
      ? getWeatherForLocation(requestedLocation, services)
      : withLocationFallback(location, fallbackLocation, (value) => getWeatherForLocation(value, services));
  }
  if (name === "time") {
    return requestedLocation
      ? getTimeForLocation(requestedLocation, services)
      : withLocationFallback(location, fallbackLocation, (value) => getTimeForLocation(value, services));
  }
  throw new Error(`Unknown local tool: ${name}`);
}

function manageUserMemory(args: LocalToolArgs, services: LocalToolServices): LocalToolResult {
  if (!services.userMemory) {
    throw new Error("User memory is not available in this runtime.");
  }
  const action = String(args.action ?? "add").toLowerCase();
  if (action === "list") {
    const items = services.userMemory.list();
    return {
      name: "memory",
      text: items.length
        ? `User memories: ${items.map((item) => `${item.id}: ${item.category}: ${item.text}`).join("; ")}.`
        : "No user memories are stored."
    };
  }
  if (action === "forget" || action === "delete" || action === "remove") {
    const removed = services.userMemory.forget({ id: args.id, text: args.text });
    return {
      name: "memory",
      text: removed ? `Forgot memory ${removed.id}: ${removed.text}.` : "No matching user memory was found."
    };
  }
  const item = services.userMemory.remember({
    text: String(args.text ?? "").trim(),
    category: args.category,
    source: args.source
  });
  return {
    name: "memory",
    text: `Remembered ${item.category}: ${item.text}`
  };
}

async function runSpotifyTool(args: LocalToolArgs, services: LocalToolServices): Promise<LocalToolResult> {
  const scriptArgs = buildSpotifyArgs(args);
  const preflight = spotifyPreflight(args, services.spotify);
  if (!preflight.ok && !preflight.recoverable) {
    return {
      name: "spotify",
      text: preflight.message,
      skillName: "spotify-control",
      script: "scripts/spotify_control.py"
    };
  }
  if (!preflight.ok) {
    const loginResult = await runSpotifyLogin(services);
    const loginText = normalizeSpotifyOutput(loginResult.text, services.spotify);
    if (isSpotifyFailure(loginText)) {
      return {
        name: "spotify",
        text: `Spotify login failed: ${loginText}`,
        skillName: loginResult.skillName,
        script: loginResult.script
      };
    }

    const nextPreflight = spotifyPreflight(args, services.spotify);
    if (!nextPreflight.ok) {
      return {
        name: "spotify",
        text: `${loginText} ${nextPreflight.message}`,
        skillName: "spotify-control",
        script: "scripts/spotify_control.py"
      };
    }
  }

  const result = await runConfiguredSkillScript(
    {
      skillName: "spotify-control",
      script: "scripts/spotify_control.py",
      args: [...spotifyGlobalArgs(services.spotify), ...scriptArgs]
    },
    services
  );
  return {
    name: "spotify",
    text: normalizeSpotifyOutput(result.text, services.spotify, args),
    skillName: result.skillName,
    script: result.script
  };
}

async function runSpotifyLogin(services: LocalToolServices): Promise<SkillScriptResult> {
  try {
    return await runConfiguredSkillScript(
      {
        skillName: "spotify-control",
        script: "scripts/spotify_control.py",
        args: [...spotifyGlobalArgs(services.spotify), "login"]
      },
      services
    );
  } catch (error) {
    return {
      name: "skill_script",
      text: String(error),
      skillName: "spotify-control",
      script: "scripts/spotify_control.py"
    };
  }
}

function runConfiguredSkillScript(args: SkillScriptArgs, services: LocalToolServices): Promise<SkillScriptResult> {
  return (services.runSkillScript ?? runSkillScript)(args);
}

function buildSpotifyArgs(args: LocalToolArgs): string[] {
  const action = String(args.action ?? "status").toLowerCase().trim();
  if (action === "login") {
    return ["login"];
  }
  if (action === "play") {
    if (args.uri) {
      return withSpotifyDevice(["play", "--uri", String(args.uri)], args);
    }
    const query = String(args.query ?? args.text ?? "").trim();
    if (!query) {
      throw new Error("Spotify play requires a query or uri.");
    }
    const command = ["play", "--query", query];
    const kind = cleanSpotifyOption(args.kind, ["track", "playlist", "album", "artist", "show", "episode"]);
    if (kind) {
      command.push("--kind", kind);
    }
    const prefer = cleanSpotifyOption(args.prefer, ["mine"]);
    if (prefer) {
      command.push("--prefer", prefer);
    }
    return withSpotifyDevice(command, args);
  }
  if (["pause", "resume", "next", "previous", "devices", "status"].includes(action)) {
    return [action];
  }
  if (action === "volume") {
    const percent = Number(args.percent);
    if (!Number.isFinite(percent)) {
      throw new Error("Spotify volume requires a percent.");
    }
    return withSpotifyDevice(["volume", "--percent", String(Math.max(0, Math.min(100, Math.round(percent))))], args);
  }
  if (action === "shuffle") {
    return withSpotifyDevice(["shuffle", "--state", booleanState(args.state)], args);
  }
  if (action === "repeat") {
    const repeatState = cleanSpotifyOption(args.state, ["off", "track", "context"]);
    if (!repeatState) {
      throw new Error("Spotify repeat requires state off, track, or context.");
    }
    return withSpotifyDevice(["repeat", "--state", repeatState], args);
  }
  throw new Error(`Unsupported Spotify action: ${action}.`);
}

function spotifyGlobalArgs(config: SpotifyToolConfig | undefined): string[] {
  const args: string[] = [];
  if (config?.clientId?.trim()) {
    args.push("--client-id", config.clientId.trim());
  }
  if (config?.redirectUri?.trim()) {
    args.push("--redirect-uri", config.redirectUri.trim());
  }
  if (config?.tokenCache?.trim()) {
    args.push("--token-cache", config.tokenCache.trim());
  }
  return args;
}

function normalizeSpotifyOutput(
  text: string,
  config: SpotifyToolConfig | undefined,
  args: LocalToolArgs = {}
): string {
  const cleanText = cleanToolOutput(text);
  const normalized = cleanText.toLowerCase();
  if (normalized.includes("invalid_client")) {
    return config?.clientId?.trim()
      ? "Spotify rejected the configured client ID. Check the Spotify client ID in settings, make sure the redirect URI is registered as http://127.0.0.1:8888/callback, then run Spotify login again."
      : "Spotify needs a client ID before playback control can work. Add your Spotify client ID in settings or set SPOTIFY_CLIENT_ID, then run Spotify login.";
  }
  if (normalized.includes("no spotify token cache found") || normalized.includes("run login first")) {
    return "Spotify is not logged in yet. Ask me to run Spotify login after setting a Spotify client ID.";
  }
  if (normalized.includes("token cannot be refreshed")) {
    return "Spotify login expired and cannot be refreshed. Ask me to run Spotify login again.";
  }
  const apiError = spotifyApiErrorMessage(cleanText);
  if (apiError) {
    return apiError;
  }
  if (normalized.includes("traceback") || normalized.includes("jsondecodeerror")) {
    return "Spotify command failed inside the Spotify helper, so I could not confirm the action. Try again; if it repeats, run Spotify status and check the Tool Timeline for details.";
  }
  const successText = spotifySuccessText(cleanText, args);
  return successText ?? cleanText;
}

function cleanToolOutput(text: string): string {
  return String(text ?? "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "")
    .trim();
}

function spotifyApiErrorMessage(text: string): string | null {
  const match = text.match(/spotify api error\s+(\d+):\s*([^\n\r]*)/i);
  if (!match) {
    return null;
  }
  const status = Number(match[1]);
  const detail = parseSpotifyErrorDetail(match[2] ?? "");
  if (status === 401) {
    return "Spotify login expired or was rejected. Run Spotify login again, then retry the command.";
  }
  if (status === 403 && /premium/i.test(detail)) {
    return "Spotify rejected the command: Premium required. Spotify Web API playback control requires Spotify Premium.";
  }
  if (status === 403) {
    return `Spotify rejected the command: ${detail || "permission denied"}.`;
  }
  if (status === 404) {
    return "Spotify has no active device. Open Spotify on a phone, browser, or desktop app, then retry.";
  }
  if (status === 429) {
    return "Spotify rate-limited the command. Wait a moment, then retry.";
  }
  return `Spotify API error ${status}: ${detail || "unknown error"}.`;
}

function parseSpotifyErrorDetail(detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const payload = JSON.parse(trimmed) as unknown;
    const root = objectValue(payload);
    const error = root ? root.error : null;
    if (typeof error === "string") {
      return error;
    }
    const errorObject = objectValue(error);
    if (typeof errorObject?.message === "string") {
      return errorObject.message;
    }
    if (typeof root?.message === "string") {
      return root.message;
    }
  } catch {
    // Fall through to plain text cleanup.
  }
  return trimmed.replace(/\s+/g, " ");
}

function spotifySuccessText(text: string, args: LocalToolArgs): string | null {
  const payload = parseJsonObject(text);
  if (!payload || payload.ok !== true) {
    return null;
  }
  const action = String(args.action ?? "").toLowerCase().trim();
  if (action === "login") {
    return "Spotify login completed.";
  }
  if (action === "pause") {
    return "Paused Spotify.";
  }
  if (action === "resume") {
    return "Resumed Spotify.";
  }
  if (action === "next") {
    return "Skipped to the next Spotify track.";
  }
  if (action === "previous") {
    return "Went back to the previous Spotify track.";
  }
  if (action === "volume") {
    return `Set Spotify volume to ${String(args.percent)} percent.`;
  }
  if (action === "shuffle") {
    return `Turned Spotify shuffle ${String(args.state).toLowerCase() === "false" ? "off" : "on"}.`;
  }
  if (action === "repeat") {
    return `Set Spotify repeat to ${String(args.state ?? "context")}.`;
  }
  if (action === "play") {
    const played = objectValue(payload.played);
    const name = typeof played?.name === "string" ? played.name : "";
    const artists = Array.isArray(played?.artists)
      ? played.artists.filter((artist): artist is string => typeof artist === "string")
      : [];
    const suffix = artists.length ? ` by ${artists.join(", ")}` : "";
    return name ? `Playing ${name}${suffix} on Spotify.` : "Started Spotify playback.";
  }
  return null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(text));
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isSpotifyFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("failed") ||
    normalized.includes("invalid_client") ||
    normalized.includes("error") ||
    normalized.includes("timed out") ||
    normalized.includes("no authorization code")
  );
}

function spotifyPreflight(args: LocalToolArgs, config: SpotifyToolConfig | undefined): SpotifyPreflightResult {
  const action = String(args.action ?? "status").toLowerCase().trim();
  if (action === "login") {
    return { ok: true };
  }

  const clientId = config?.clientId?.trim() || process.env.SPOTIFY_CLIENT_ID?.trim() || "";
  if (!clientId) {
    return {
      ok: false,
      recoverable: false,
      message:
        "Spotify needs a client ID before playback control can work. Add your Spotify client ID in settings, save, then run Spotify login."
    };
  }

  const cachePath = spotifyTokenCachePath(config);
  if (!fs.existsSync(cachePath)) {
    return {
      ok: false,
      recoverable: true,
      message: "Spotify is not logged in yet."
    };
  }

  try {
    const token = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as { client_id?: string; redirect_uri?: string };
    const cachedClientId = String(token.client_id ?? "").trim();
    if (cachedClientId && cachedClientId !== clientId) {
      return {
        ok: false,
        recoverable: true,
        message: "Spotify is logged in with a different Spotify app client ID."
      };
    }
    const configuredRedirect = config?.redirectUri?.trim();
    const cachedRedirect = String(token.redirect_uri ?? "").trim();
    if (configuredRedirect && cachedRedirect && cachedRedirect !== configuredRedirect) {
      return {
        ok: false,
        recoverable: true,
        message: "Spotify is logged in with a different redirect URI."
      };
    }
  } catch {
    return {
      ok: false,
      recoverable: true,
      message: "Spotify token cache is unreadable."
    };
  }

  return { ok: true };
}

function spotifyTokenCachePath(config: SpotifyToolConfig | undefined): string {
  if (config?.tokenCache?.trim()) {
    return path.resolve(config.tokenCache.trim());
  }
  if (process.platform === "win32") {
    const root = process.env.APPDATA || process.env.LOCALAPPDATA;
    if (root) {
      return path.join(root, "Codex", "spotify-control", "token.json");
    }
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(xdg, "codex", "spotify-control", "token.json");
  }
  return path.join(os.homedir(), ".config", "codex", "spotify-control", "token.json");
}

function withSpotifyDevice(command: string[], args: LocalToolArgs): string[] {
  const deviceName = String(args.deviceName ?? "").trim();
  return deviceName ? [...command, "--device-name", deviceName] : command;
}

function cleanSpotifyOption(value: unknown, allowed: string[]): string {
  const normalized = String(value ?? "").toLowerCase().trim();
  return allowed.includes(normalized) ? normalized : "";
}

function booleanState(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  const normalized = String(value ?? "").toLowerCase().trim();
  if (["true", "on", "yes", "enable", "enabled"].includes(normalized)) {
    return "true";
  }
  if (["false", "off", "no", "disable", "disabled"].includes(normalized)) {
    return "false";
  }
  throw new Error("Spotify shuffle requires a boolean state.");
}

function manageAlarm(args: LocalToolArgs, services: LocalToolServices): LocalToolResult {
  const action = String(args.action ?? "set").toLowerCase();
  const now = services.now?.() ?? Date.now();
  const clearTimer = services.clearTimeout ?? clearTimeout;
  if (action === "list") {
    const pending = Array.from(alarms.values()).sort((left, right) => left.dueAt - right.dueAt);
    return {
      name: "alarm",
      text: pending.length
        ? `Active alarms: ${pending.map(formatAlarm).join("; ")}.`
        : "There are no active alarms."
    };
  }
  if (action === "cancel" || action === "delete" || action === "remove") {
    const id = String(args.id ?? "").trim();
    if (!id) {
      throw new Error("Missing alarm id to cancel.");
    }
    const alarm = alarms.get(id);
    if (!alarm) {
      throw new Error(`No active alarm found with id ${id}.`);
    }
    clearTimer(alarm.timeout);
    alarms.delete(id);
    return { name: "alarm", text: `Cancelled alarm ${id}: ${alarm.label}.` };
  }

  const dueAt = parseAlarmTime(args.time ?? "", now);
  const label = String(args.label ?? "Alarm").trim() || "Alarm";
  const id = `alarm-${now.toString(36)}`;
  const delayMs = Math.max(0, dueAt - now);
  const setTimer = services.setTimeout ?? setTimeout;
  const timeout = setTimer(() => {
    const alarm = alarms.get(id);
    if (!alarm) {
      return;
    }
    alarms.delete(id);
    services.onAlarm?.({ id, dueAt, label });
  }, delayMs);
  alarms.set(id, { id, dueAt, label, timeout });
  return {
    name: "alarm",
    text: `Set alarm ${id} for ${formatDateTimeLocal(dueAt)}: ${label}.`
  };
}

function parseAlarmTime(value: string, now = Date.now()): number {
  const input = value.trim().toLowerCase();
  if (!input) {
    throw new Error("Missing alarm time.");
  }
  const duration = input.match(/\b(?:in\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2];
    const multiplier = /^s/.test(unit) ? 1000 : /^m/.test(unit) ? 60_000 : 3_600_000;
    return now + amount * multiplier;
  }
  const atTime = input.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (atTime) {
    const due = new Date(now);
    let hour = Number(atTime[1]);
    const minute = Number(atTime[2] ?? 0);
    const meridiem = atTime[3];
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    due.setHours(hour, minute, 0, 0);
    if (due.getTime() <= now) {
      due.setDate(due.getDate() + 1);
    }
    return due.getTime();
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  throw new Error(`Could not understand alarm time: ${value}.`);
}

function formatAlarm(alarm: AlarmItem): string {
  return `${alarm.id} at ${formatDateTimeLocal(alarm.dueAt)} (${alarm.label})`;
}

function formatDateTimeLocal(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

async function openApp(appName: string, services: LocalToolServices): Promise<LocalToolResult> {
  const raw = String(appName ?? "").trim();
  const app = normalizeAppName(cleanAppTarget(raw));
  if (!app) {
    throw new Error("Missing app name.");
  }
  if (!services.openApp) {
    return {
      name: "open_app",
      text: "Opening apps is not available in this runtime."
    };
  }
  const outcome = await services.openApp(app);
  if (outcome && outcome.opened === false) {
    const fallbackSite = websiteAliasForName(raw);
    if (fallbackSite && services.openWebsite) {
      return openWebsite(fallbackSite, services);
    }
    return {
      name: "open_app",
      opened: false,
      text: outcome.detail || `I couldn't find ${app} on this computer. Check the name or install it first.`
    };
  }
  return { name: "open_app", opened: true, text: outcome?.detail ?? `Opened ${app}.` };
}

async function openWebsite(value: string, services: LocalToolServices): Promise<LocalToolResult> {
  const url = normalizeWebsiteUrl(value);
  if (!services.openWebsite) {
    throw new Error("Opening websites is not available in this runtime.");
  }
  await services.openWebsite(url);
  return { name: "open_website", url, text: `Opened ${url}.` };
}

function normalizeAppName(value: string): string {
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (APP_ALIASES[normalized]) {
    return APP_ALIASES[normalized];
  }
  if (process.platform === "darwin") {
    return titleCaseAppName(value);
  }
  return value;
}

function titleCaseAppName(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function normalizeWebsiteUrl(value: string): string {
  const input = cleanAppTarget(String(value ?? "").trim());
  if (!input) {
    throw new Error("Missing website URL.");
  }
  const normalized = input.toLowerCase();
  const domain = WEBSITE_ALIASES[normalized] ?? (/^[a-z0-9-]+$/i.test(input) ? `${input}.com` : input);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(domain) ? domain : `https://${domain}`;
  const url = new URL(withScheme);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https websites can be opened.");
  }
  return url.toString();
}

function resolveDirectWeatherTool(prompt: string): LocalToolInvocation | null {
  const normalized = normalizeCommandText(prompt);
  if (!/\b(weather|forecast|temperature|temp|rain|snow|wind|humidity|sunny|cloudy)\b/.test(normalized)) {
    return null;
  }
  const location = extractLocationFromPrompt(prompt);
  return { name: "weather", args: location ? { location } : {} };
}

function resolveDirectTimeTool(prompt: string): LocalToolInvocation | null {
  const normalized = normalizeCommandText(prompt);
  if (/\b(weather|forecast|temperature|temp|rain|snow|wind)\b/.test(normalized)) {
    return null;
  }
  const asksTime =
    /\b(what time|what s the time|whats the time|current time|time is it|what date|what s the date|what day)\b/.test(
      normalized
    ) ||
    (/\b(time|date|day)\b/.test(normalized) && /\b(what|current|now|today|tonight|tomorrow)\b/.test(normalized));
  if (!asksTime) {
    return null;
  }
  const location = extractLocationFromPrompt(prompt);
  return { name: "time", args: location ? { location } : {} };
}

function resolveDirectSpotifyTool(prompt: string): LocalToolInvocation | null {
  const normalized = normalizeCommandText(prompt);
  if (!/\bspotify\b/.test(normalized)) {
    return null;
  }

  const volumePercent = spotifyVolumePercent(normalized);
  if (volumePercent !== null) {
    return { name: "spotify", args: { action: "volume", percent: volumePercent } };
  }

  if (/\b(log\s*in|login|authorize|reauthorize|connect)\b.*\bspotify\b|\bspotify\b.*\b(log\s*in|login|authorize|reauthorize|connect)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "login" } };
  }
  if (/\b(list|show|get|what(?:'s| is)?)\b.*\b(devices|speakers|players)\b.*\bspotify\b|\bspotify\b.*\b(devices|speakers|players)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "devices" } };
  }
  if (/\b(what(?:'s| is)? playing|current (song|track|playback)|spotify status|status (?:of|for|on) spotify)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "status" } };
  }
  if (/\b(pause|stop)\b.*\bspotify\b|\bspotify\b.*\b(pause|stop)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "pause" } };
  }
  if (/\b(resume|continue|unpause)\b.*\bspotify\b|\bspotify\b.*\b(resume|continue|unpause)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "resume" } };
  }
  if (/\b(skip|next)\b.*\bspotify\b|\bspotify\b.*\b(skip|next)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "next" } };
  }
  if (/\b(previous|prev|back|last)\b.*\bspotify\b|\bspotify\b.*\b(previous|prev|back|last)\b/.test(normalized)) {
    return { name: "spotify", args: { action: "previous" } };
  }

  const shuffleState = spotifyOnOffState(normalized, "shuffle");
  if (shuffleState !== null) {
    return { name: "spotify", args: { action: "shuffle", state: shuffleState } };
  }

  const repeatState = spotifyRepeatState(normalized);
  if (repeatState) {
    return { name: "spotify", args: { action: "repeat", state: repeatState } };
  }

  const playArgs = spotifyPlayArgs(prompt);
  return playArgs ? { name: "spotify", args: playArgs } : null;
}

function resolveContextualSpotifyTool(prompt: string): LocalToolInvocation | null {
  const normalized = normalizeCommandText(prompt);
  if (!normalized) {
    return null;
  }

  if (/\bspotify\b/.test(normalized)) {
    return resolveDirectSpotifyTool(prompt);
  }

  const volumePercent = contextualVolumePercent(normalized);
  if (volumePercent !== null) {
    return { name: "spotify", args: { action: "volume", percent: volumePercent } };
  }

  const command = normalized.replace(/^please\s+/, "").trim();
  const mediaObject = "(?:it|this(?: song| track)?|the (?:song|track)|song|track|music|playback)";
  if (new RegExp(`^(?:pause|stop)(?:\\s+${mediaObject})?$`).test(command)) {
    return { name: "spotify", args: { action: "pause" } };
  }
  if (new RegExp(`^(?:resume|continue|unpause|play)(?:\\s+${mediaObject})?$`).test(command)) {
    return { name: "spotify", args: { action: "resume" } };
  }
  if (
    new RegExp(`^(?:skip|next)(?:\\s+${mediaObject})?$`).test(command) ||
    /^(?:skip|next)\s+(?:song|track)$/.test(command)
  ) {
    return { name: "spotify", args: { action: "next" } };
  }
  if (/^(?:(?:go\s+)?back|previous|prev|last)(?:\s+(?:song|track))?$/.test(command)) {
    return { name: "spotify", args: { action: "previous" } };
  }
  if (/^(?:what(?:'s| is)? playing|current (?:song|track|playback)|status)$/.test(command)) {
    return { name: "spotify", args: { action: "status" } };
  }

  const shuffleState = contextualOnOffState(normalized, "shuffle");
  if (shuffleState !== null) {
    return { name: "spotify", args: { action: "shuffle", state: shuffleState } };
  }

  const repeatState = contextualRepeatState(normalized);
  if (repeatState) {
    return { name: "spotify", args: { action: "repeat", state: repeatState } };
  }

  const playArgs = spotifyPlayArgs(prompt);
  if (playArgs) {
    return { name: "spotify", args: playArgs };
  }

  return null;
}

function spotifyPlayArgs(prompt: string): LocalToolArgs | null {
  const patterns = [
    /^(?:please\s+)?play\s+(.+?)(?:\s+(?:on|in|with|using)\s+spotify|\s+spotify)?$/i,
    /^(?:please\s+)?spotify\s+play\s+(.+)$/i
  ];
  const match = patterns.map((pattern) => prompt.match(pattern)).find(Boolean);
  if (!match) {
    return null;
  }

  const query = cleanSpotifyPlayQuery(match[1]);
  if (!query) {
    return { action: "resume" };
  }

  const kind = inferSpotifyKind(prompt);
  const args: LocalToolArgs = { action: "play", query, kind };
  if (kind === "playlist" && /\bmy\b/i.test(prompt)) {
    args.prefer = "mine";
  }
  return args;
}

function cleanSpotifyPlayQuery(value: string): string {
  return value
    .replace(/\b(?:on|in|with|using)\s+spotify\b/gi, "")
    .replace(/\bspotify\b/gi, "")
    .replace(/^(?:the\s+)?(?:song|track|playlist|album|artist|podcast|show|episode)\s+/i, "")
    .replace(/\s+(?:song|track|playlist|album|artist|podcast|show|episode)$/i, "")
    .replace(/\s+(for me|please|thanks|thank you)$/i, "")
    .trim();
}

function inferSpotifyKind(prompt: string): string {
  const normalized = normalizeCommandText(prompt);
  if (/\bplaylist\b/.test(normalized)) {
    return "playlist";
  }
  if (/\balbum\b/.test(normalized)) {
    return "album";
  }
  if (/\bartist\b/.test(normalized)) {
    return "artist";
  }
  if (/\b(podcast|show)\b/.test(normalized)) {
    return "show";
  }
  if (/\bepisode\b/.test(normalized)) {
    return "episode";
  }
  return "track";
}

function spotifyVolumePercent(normalized: string): number | null {
  if (!/\bspotify\b/.test(normalized) || !/\bvolume\b/.test(normalized)) {
    return null;
  }
  return volumePercentFromCommand(normalized);
}

function contextualVolumePercent(normalized: string): number | null {
  if (!/\bvolume\b/.test(normalized)) {
    return null;
  }
  return volumePercentFromCommand(normalized);
}

function volumePercentFromCommand(normalized: string): number | null {
  const percentMatch = normalized.match(/\b(\d{1,3})\s*(?:%|percent)\b/);
  const setToMatch = normalized.match(/\b(?:to|at)\s+(\d{1,3})\b/);
  const value = Number(percentMatch?.[1] ?? setToMatch?.[1] ?? Number.NaN);
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function contextualOnOffState(normalized: string, word: string): string | null {
  if (!normalized.includes(word)) {
    return null;
  }
  if (new RegExp(`\\b${word}\\b.*\\b(off|disable|disabled)\\b|\\b(off|disable|disabled)\\b.*\\b${word}\\b`).test(normalized)) {
    return "false";
  }
  if (new RegExp(`\\b${word}\\b.*\\b(on|enable|enabled)\\b|\\b(on|enable|enabled)\\b.*\\b${word}\\b`).test(normalized)) {
    return "true";
  }
  return null;
}

function spotifyOnOffState(normalized: string, word: string): string | null {
  if (!normalized.includes(word) || !/\bspotify\b/.test(normalized)) {
    return null;
  }
  const commandOnly = normalized.replace(/\bon spotify\b|\bspotify\b/g, " ").replace(/\s+/g, " ").trim();
  if (new RegExp(`\\b${word}\\b.*\\b(off|disable|disabled)\\b|\\b(off|disable|disabled)\\b.*\\b${word}\\b`).test(commandOnly)) {
    return "false";
  }
  if (new RegExp(`\\b${word}\\b.*\\b(on|enable|enabled)\\b|\\b(on|enable|enabled)\\b.*\\b${word}\\b`).test(commandOnly)) {
    return "true";
  }
  return null;
}

function contextualRepeatState(normalized: string): string | null {
  if (!/\brepeat\b/.test(normalized)) {
    return null;
  }
  if (/\boff\b/.test(normalized)) {
    return "off";
  }
  if (/\b(track|song|one)\b/.test(normalized)) {
    return "track";
  }
  if (/\b(context|playlist|album|on)\b/.test(normalized)) {
    return "context";
  }
  return null;
}

function spotifyRepeatState(normalized: string): string | null {
  if (!/\brepeat\b/.test(normalized) || !/\bspotify\b/.test(normalized)) {
    return null;
  }
  if (/\boff\b/.test(normalized)) {
    return "off";
  }
  if (/\b(track|song|one)\b/.test(normalized)) {
    return "track";
  }
  if (/\b(context|playlist|album|on)\b/.test(normalized)) {
    return "context";
  }
  return null;
}

function normalizeCommandText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s'%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isKnownAppTarget(normalized: string, target: string): boolean {
  if (APP_ALIASES[normalized]) {
    return true;
  }
  if (/\.exe$/i.test(target.trim())) {
    return true;
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(target.trim()) && !/^https?:/i.test(target.trim());
}

/** Short app names like "discord" or "visual studio" — skip the LLM and open directly. */
function isDirectAppLaunchTarget(normalized: string, target: string): boolean {
  if (isKnownAppTarget(normalized, target)) {
    return true;
  }
  const stripped = normalized.replace(/^(the|my|a|an)\s+/, "").trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 2) {
    return false;
  }
  const blocked = new Set([
    "pod",
    "bay",
    "doors",
    "source",
    "software",
    "file",
    "files",
    "folder",
    "document",
    "window",
    "tab",
    "page",
    "link",
    "url"
  ]);
  if (words.some((word) => blocked.has(word))) {
    return false;
  }
  return /^[a-z0-9][a-z0-9\s.-]*$/i.test(stripped);
}

function isWebsiteTarget(normalized: string, target: string): boolean {
  const trimmed = target.trim();
  return (
    Boolean(WEBSITE_ALIASES[normalized]) ||
    /^https?:\/\//i.test(trimmed) ||
    /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/.*)?$/i.test(trimmed)
  );
}

async function webSearch(query: string, services: LocalToolServices): Promise<LocalToolResult> {
  const cleanQuery = String(query ?? "").trim();
  if (!cleanQuery) {
    throw new Error("Missing web search query.");
  }
  if (services.webSearch) {
    const payload = await services.webSearch(cleanQuery);
    const results = payload.results.slice(0, 5);
    const fetchedAt = payload.fetchedAt ?? new Date().toISOString();
    if (!results.length) {
      return { name: "web_search", query: cleanQuery, fetchedAt, text: `No web results found for ${cleanQuery}.`, results: [] };
    }
    return formatWebSearchResult(cleanQuery, fetchedAt, results);
  }
  return duckDuckGoSearch(cleanQuery, services.fetch);
}

async function duckDuckGoSearch(query: string, fetchService?: FetchService): Promise<LocalToolResult> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetchWithRetry(url, 20000, 2, fetchService);
  if (!response.ok) {
    throw new Error(`web search failed with HTTP ${response.status}`);
  }
  const html = await response.text();
  const results = parseDuckDuckGoResults(html).slice(0, 5);
  const fetchedAt = new Date().toISOString();
  if (!results.length) {
    return { name: "web_search", query, fetchedAt, text: `No web results found for ${query}.`, results: [] };
  }
  return formatWebSearchResult(query, fetchedAt, results);
}

function formatWebSearchResult(query: string, fetchedAt: string, results: WebSearchResult[]): LocalToolResult {
  return {
    name: "web_search",
    query,
    fetchedAt,
    results,
    text:
      `Web search results for "${query}" fetched ${fetchedAt}: ` +
      results
        .map((result, index) => `${index + 1}. ${result.title}. ${result.snippet || "No snippet."} Source: ${result.url}`)
        .join(" ")
  };
}

function parseDuckDuckGoResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blocks = html.split(/<div class="result results_links/gi).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const url = decodeDuckDuckGoUrl(decodeHtml(titleMatch[1]));
    const title = decodeHtml(stripTags(titleMatch[2])).trim();
    const snippet = decodeHtml(stripTags(snippetMatch?.[1] ?? "")).trim();
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

function decodeDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return value;
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function inspectScreen(args: LocalToolArgs, services: LocalToolServices): Promise<LocalToolResult> {
  if (!services.captureScreen) {
    throw new Error("Screen capture is not available in this runtime.");
  }
  const prompt = String(args.query ?? args.task ?? "Describe what is on my screen.").trim();
  const screenshot = await services.captureScreen();
  const analysis = services.analyzeScreen
    ? await services.analyzeScreen(screenshot.path, prompt)
    : "Screen interpretation requires a vision-capable local model; this runtime only captured the screenshot.";
  return {
    name: "screen",
    path: screenshot.path,
    text: `Screen capture: ${screenshot.path} (${screenshot.width}x${screenshot.height}). ${analysis}`
  };
}

function calculate(expression: string): LocalToolResult {
  const normalized = normalizeMathExpression(expression);
  if (!normalized || !/^[\d\s+\-*/%.()]+$/.test(normalized)) {
    throw new Error("Calculator expression contains unsupported characters.");
  }
  const value = Function(`"use strict"; return (${normalized});`)() as unknown;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Calculator expression did not produce a finite number.");
  }
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/g, "").replace(/\.$/g, "");
  return {
    name: "calculator",
    text: `${expression} = ${formatted}`
  };
}

const CODE_TIMEOUT_MS = 20000;
const CODE_OUTPUT_LIMIT = 4000;

/**
 * Execute a short model-written program locally. Python runs via the system
 * python3; JavaScript runs via Electron's own binary in Node mode
 * (ELECTRON_RUN_AS_NODE), so no separate Node install is needed. Everything
 * stays on-device: temp file in, stdout/stderr out, hard 20 s timeout.
 */
async function runCodeTool(args: LocalToolArgs): Promise<LocalToolResult> {
  const code = String(args.code ?? "").trim();
  if (!code) {
    throw new Error("Missing code to run.");
  }
  const language = normalizeCodeLanguage(String(args.language ?? "python"));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "pythos-code-"));
  const file = path.join(scratchDir, language === "python" ? "main.py" : "main.mjs");
  fs.writeFileSync(file, code, "utf-8");

  const command = language === "python" ? resolvePythonBinary() : process.execPath;
  const commandArgs = language === "python" ? [file] : [file];
  const env =
    language === "python"
      ? process.env
      : { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

  const output = await new Promise<{ stdout: string; stderr: string; failed: string | null }>((resolve) => {
    execFile(
      command,
      commandArgs,
      { timeout: CODE_TIMEOUT_MS, maxBuffer: 1024 * 1024, cwd: scratchDir, env },
      (error, stdout, stderr) => {
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          failed: error ? (error.killed ? "Timed out after 20 seconds." : error.message) : null
        });
      }
    );
  });

  try {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // Scratch cleanup is best-effort.
  }

  const stdout = truncateOutput(output.stdout);
  const stderr = truncateOutput(output.stderr);
  const label = args.description ? `${args.description}. ` : "";
  if (output.failed && !stdout) {
    return {
      name: "run_code",
      text: `${label}The ${language} program failed: ${truncateOutput(output.failed)}${stderr ? ` Stderr: ${stderr}` : ""}`
    };
  }
  return {
    name: "run_code",
    text:
      `${label}Ran ${language} locally. Output:\n${stdout || "(no output printed)"}` +
      (stderr ? `\nStderr: ${stderr}` : "")
  };
}

const CLIPBOARD_TIMEOUT_MS = 5000;

/** Read the system clipboard on-device (pbpaste / PowerShell / xclip). No model call. */
async function readClipboard(): Promise<LocalToolResult> {
  const [command, commandArgs] =
    process.platform === "darwin"
      ? (["pbpaste", []] as const)
      : process.platform === "win32"
        ? (["powershell", ["-NoProfile", "-Command", "Get-Clipboard"]] as const)
        : (["xclip", ["-selection", "clipboard", "-o"]] as const);

  const text = await new Promise<string>((resolve) => {
    execFile(command, [...commandArgs], { timeout: CLIPBOARD_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : String(stdout ?? "").trim());
    });
  });

  if (!text) {
    return { name: "clipboard", text: "Your clipboard is empty, or I could not read it." };
  }
  const clipped = text.length > 1200 ? `${text.slice(0, 1200)}… (truncated)` : text;
  return { name: "clipboard", text: `Your clipboard contains: ${clipped}` };
}

const HOME_FOLDER_ALIASES: Record<string, string> = {
  downloads: "Downloads",
  download: "Downloads",
  desktop: "Desktop",
  documents: "Documents",
  pictures: "Pictures",
  music: "Music",
  movies: "Movies",
  home: "."
};

/** List a folder under the user's home directory without an LLM or MCP round-trip. */
function listFolder(pathArg: string): LocalToolResult {
  const homedir = os.homedir();
  const normalized = pathArg.toLowerCase().replace(/\s+folder$/, "").trim();
  const segment = HOME_FOLDER_ALIASES[normalized] ?? pathArg.trim();
  const resolved = segment === "." ? homedir : path.join(homedir, segment);
  const resolvedReal = path.resolve(resolved);
  if (!resolvedReal.startsWith(homedir)) {
    return { name: "list_folder", text: "I can only list folders in your home directory." };
  }
  try {
    const entries = fs.readdirSync(resolvedReal, { withFileTypes: true }).slice(0, 30);
    if (!entries.length) {
      return { name: "list_folder", text: `${path.basename(resolvedReal) || "home"} is empty.` };
    }
    const lines = entries.map((entry) => `${entry.isDirectory() ? "folder" : "file"}: ${entry.name}`);
    const suffix = entries.length >= 30 ? "\n(showing first 30 items)" : "";
    return {
      name: "list_folder",
      text: `In ${path.basename(resolvedReal) || "home"}:\n${lines.join("\n")}${suffix}`
    };
  } catch (error) {
    return { name: "list_folder", text: `I couldn't read that folder: ${String(error)}` };
  }
}

/** Instant, model-free capability summary for "what can you do?" style prompts. */
function describeCapabilities(): LocalToolResult {
  return {
    name: "capabilities",
    text:
      "I'm Pythos, running entirely on-device with local Gemma. I can open apps and websites, " +
      "look at your screen and describe it with local vision, check weather and time, set alarms, " +
      "control Spotify, do math, run code, search the web, research topics, use system tools like " +
      "clipboard, files, and notes, and remember things you tell me. Everything runs locally, so it " +
      "keeps working offline and your voice never leaves the machine."
  };
}

function normalizeCodeLanguage(value: string): "python" | "javascript" {
  const lower = value.toLowerCase().trim();
  if (["js", "javascript", "node", "nodejs", "typescript", "ts"].includes(lower)) {
    return "javascript";
  }
  return "python";
}

let cachedPythonBinary: string | null = null;

function resolvePythonBinary(): string {
  if (cachedPythonBinary) {
    return cachedPythonBinary;
  }
  for (const candidate of ["python3", "python"]) {
    try {
      execFileSync(candidate, ["--version"], { timeout: 5000, stdio: "ignore" });
      cachedPythonBinary = candidate;
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  cachedPythonBinary = "python3";
  return cachedPythonBinary;
}

function truncateOutput(value: string): string {
  const clean = value.trim();
  return clean.length > CODE_OUTPUT_LIMIT ? `${clean.slice(0, CODE_OUTPUT_LIMIT)}… (truncated)` : clean;
}

let cachedCursorAgentAvailable: boolean | null = null;

/** True when the Cursor agent CLI is installed, so the delegation tool can be offered. */
export function isCursorAgentAvailable(): boolean {
  if (cachedCursorAgentAvailable !== null) {
    return cachedCursorAgentAvailable;
  }
  try {
    execFileSync("cursor-agent", ["--version"], { timeout: 5000, stdio: "ignore" });
    cachedCursorAgentAvailable = true;
  } catch {
    cachedCursorAgentAvailable = false;
  }
  return cachedCursorAgentAvailable;
}

/**
 * Delegate a larger coding task to the user's Cursor agent CLI when installed.
 * This is an online enhancement on top of the local Gemma brain; the tool is
 * only declared to the model when `cursor-agent` is actually present.
 */
async function runCursorAgentTool(args: LocalToolArgs): Promise<LocalToolResult> {
  const task = String(args.task ?? args.query ?? "").trim();
  if (!task) {
    throw new Error("Missing task for the Cursor agent.");
  }
  if (!isCursorAgentAvailable()) {
    return {
      name: "cursor_agent",
      text: "The Cursor agent CLI is not installed, so I could not delegate the coding task. I can still write and run short programs locally with run_code."
    };
  }
  const workspace =
    process.env.PYTHOS_CURSOR_WORKSPACE?.trim() ||
    process.env.CURSOR_WORKSPACE?.trim() ||
    process.cwd();
  const output = await new Promise<{ stdout: string; stderr: string; failed: string | null }>((resolve) => {
    execFile(
      "cursor-agent",
      ["-p", task, "--output-format", "text"],
      { timeout: 180000, maxBuffer: 4 * 1024 * 1024, cwd: workspace },
      (error, stdout, stderr) => {
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          failed: error ? error.message : null
        });
      }
    );
  });
  if (output.failed && !output.stdout.trim()) {
    return { name: "cursor_agent", text: `Cursor agent failed: ${truncateOutput(output.failed)}` };
  }
  return { name: "cursor_agent", text: `Cursor agent result: ${truncateOutput(output.stdout)}` };
}

async function withLocationFallback(
  location: string,
  fallbackLocation: string,
  runner: (location: string) => Promise<LocalToolResult>
): Promise<LocalToolResult> {
  try {
    return await runner(location);
  } catch (error) {
    if (location.toLowerCase() === fallbackLocation.toLowerCase()) {
      throw error;
    }
    return runner(fallbackLocation);
  }
}

async function getWeather(
  prompt: string,
  knownLocation: string | null,
  services: LocalToolServices
): Promise<LocalToolResult> {
  const location = extractLocationFromPrompt(prompt, knownLocation) ?? knownLocation ?? "Eagan, Minnesota";
  return getWeatherForLocation(location, services);
}

async function getWeatherForLocation(location: string, services: LocalToolServices): Promise<LocalToolResult> {
  const place = services.geocode ? await services.geocode(location) : await geocode(location, services.fetch);
  const forecast = services.forecast
    ? await services.forecast(place)
    : await fetchOpenMeteoForecast(place, services.fetch);
  const current = forecast.current;
  if (!current) {
    throw new Error("weather lookup did not return current conditions");
  }

  const name = formatPlace(place);
  const temp = round(current.temperature_2m);
  const feels = round(current.apparent_temperature);
  const humidity = round(current.relative_humidity_2m);
  const wind = round(current.wind_speed_10m);
  const precip = current.precipitation ?? 0;
  const condition = weatherCodeToText(current.weather_code);
  return {
    name: "weather",
    location: name,
    text: `Current weather in ${name}: ${condition}, ${temp} degrees Fahrenheit, feels like ${feels}. Humidity is ${humidity} percent, wind is ${wind} miles per hour, and precipitation is ${precip} inches.`
  };
}

async function fetchOpenMeteoForecast(place: GeocodedPlace, fetchService?: FetchService): Promise<WeatherForecast> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", place.timezone ?? "auto");

  const response = await fetchWithRetry(url, 20000, 2, fetchService);
  if (!response.ok) {
    throw new Error(`weather lookup failed with HTTP ${response.status}`);
  }
  return (await response.json()) as WeatherForecast;
}

async function getTime(
  prompt: string,
  knownLocation: string | null,
  services: LocalToolServices
): Promise<LocalToolResult> {
  const location = extractLocationFromPrompt(prompt) ?? knownLocation;
  if (location) {
    return getTimeForLocation(location, services);
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    name: "time",
    text: `The current local time is ${formatDateTime(timezone)}.`
  };
}

async function getTimeForLocation(location: string, services: LocalToolServices): Promise<LocalToolResult> {
  if (location) {
    const place = services.geocode ? await services.geocode(location) : await geocode(location, services.fetch);
    const timezone = place.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      name: "time",
      location: formatPlace(place),
      text: `The current time in ${formatPlace(place)} is ${formatDateTime(timezone)}.`
    };
  }
  throw new Error("Missing location for time tool.");
}

async function geocode(location: string, fetchService?: FetchService): Promise<GeocodedPlace> {
  for (const query of locationQueries(location)) {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", query);
    url.searchParams.set("count", "5");
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");

    const response = await fetchWithRetry(url, 15000, 2, fetchService);
    if (!response.ok) {
      throw new Error(`location lookup failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as GeocodeResult;
    const place = choosePlace(payload.results, location);
    if (place) {
      return place;
    }
  }
  throw new Error(`I could not find a location named ${location}.`);
}

function formatPlace(place: GeocodedPlace): string {
  return [place.name, place.admin1, place.country].filter(Boolean).join(", ");
}

function locationQueries(location: string): string[] {
  const trimmed = location.trim();
  const withoutState = trimmed
    .replace(/\b(minnesota|mn|wisconsin|wi|iowa|ia|north dakota|south dakota|new york|ny)\b/gi, "")
    .replace(/,\s*$/g, "")
    .trim();
  const cityState = trimmed.match(/^([a-z\s.-]+),?\s+([a-z]{2})$/i);
  const commaExpanded = cityState ? `${cityState[1].trim()}, ${stateName(cityState[2])}` : "";
  return Array.from(new Set([trimmed, commaExpanded, withoutState].filter((value) => value.length >= 2)));
}

function choosePlace(
  results: GeocodeResult["results"] | undefined,
  originalLocation: string
): GeocodedPlace | null {
  if (!results?.length) {
    return null;
  }
  const normalized = originalLocation.toLowerCase();
  if (/\b(minnesota|mn)\b/.test(normalized)) {
    const minnesota = results.find((place) => place.admin1?.toLowerCase() === "minnesota");
    if (minnesota) {
      return minnesota;
    }
  }
  if (/\b(new york|ny)\b/.test(normalized)) {
    const newYork = results.find((place) => place.admin1?.toLowerCase() === "new york");
    if (newYork) {
      return newYork;
    }
  }
  const requestedName = normalized.split(",")[0]?.trim();
  const exactNameMatches = results.filter((place) => place.name.toLowerCase() === requestedName);
  if (exactNameMatches.length > 1) {
    return exactNameMatches.sort((left, right) => (right.population ?? 0) - (left.population ?? 0))[0];
  }
  return results[0];
}

function stateName(abbreviation: string): string {
  const states: Record<string, string> = {
    mn: "Minnesota",
    ny: "New York",
    wi: "Wisconsin",
    ia: "Iowa",
    nd: "North Dakota",
    sd: "South Dakota"
  };
  return states[abbreviation.toLowerCase()] ?? abbreviation;
}

function formatDateTime(timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date());
}

async function fetchWithRetry(
  url: URL,
  timeoutMs: number,
  attempts: number,
  fetchService: FetchService = fetch
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchWithTimeout(url, timeoutMs, fetchService);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientFetchError(error)) {
        break;
      }
      await delay(400 * attempt);
    }
  }
  if (isAbortError(lastError)) {
    throw new Error(`${url.hostname} did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function fetchWithTimeout(url: URL, timeoutMs: number, fetchService: FetchService): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetchService(url, { signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function isTransientFetchError(error: unknown): boolean {
  return isAbortError(error) || error instanceof TypeError;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function round(value: number | undefined): number {
  return Math.round(value ?? 0);
}

function weatherCodeToText(code: number | undefined): string {
  if (code === undefined) return "unknown conditions";
  if (code === 0) return "clear sky";
  if ([1, 2, 3].includes(code)) return "partly cloudy";
  if ([45, 48].includes(code)) return "fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([95, 96, 99].includes(code)) return "thunderstorms";
  return "mixed conditions";
}
