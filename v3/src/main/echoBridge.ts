import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { URL } from "node:url";
import { appRoot, caBundleEnv, resolveWorkerPython } from "./config.js";

type EchoPromptContext = {
  deviceId: string;
  sessionId: string;
  transcript: string;
  deviceName?: string;
  source?: "audio" | "text" | "realtime";
};

type EchoBridgeOptions = {
  port?: number;
  onPrompt: (context: EchoPromptContext) => Promise<EchoPromptReply>;
  onEvent?: (event: EchoBridgeEvent) => void;
};

export type EchoPromptReply = string | { text: string; toolUsed?: boolean };

type NormalizedEchoPromptReply = {
  text: string;
  toolUsed: boolean;
};

export type EchoBridgeEvent =
  | { type: "listening"; payload: { url: string; uploadUrl: string; wsUrl: string } }
  | { type: "device_event"; payload: Record<string, unknown> }
  | { type: "realtime_state"; payload: Record<string, unknown> }
  | { type: "upload_started"; payload: { deviceId: string; sessionId: string; deviceName?: string } }
  | { type: "transcript"; payload: { deviceId: string; sessionId: string; text: string; deviceName?: string } }
  | { type: "reply"; payload: { deviceId: string; sessionId: string; text: string; audioUrl: string; deviceName?: string } }
  | { type: "error"; payload: { message: string; source: string } };

type ParsedUpload = {
  deviceId: string;
  sessionId: string;
  deviceName?: string;
  fileName: string;
  file: Buffer;
};

type RemoteTextRequest = {
  deviceId: string;
  sessionId: string;
  deviceName?: string;
  text: string;
};

const echoPlaybackVolume = clampNumber(Number(process.env.PYTHOS_ECHO_PLAYBACK_VOLUME ?? 0.9), 0, 1, 0.9);
const echoStreamVolume = Math.round(clampNumber(Number(process.env.PYTHOS_ECHO_STREAM_VOLUME ?? 24), 0, 30, 24));

class EchoSocket {
  private readonly chunks: Buffer[] = [];

  constructor(
    private readonly socket: Duplex,
    private readonly onJson: (value: Record<string, unknown>) => void,
    private readonly onBinary: (data: Buffer) => void,
    private readonly onClose: () => void
  ) {
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("close", onClose);
    socket.on("error", onClose);
  }

  sendJson(value: Record<string, unknown>): void {
    this.sendFrame(Buffer.from(JSON.stringify(value), "utf-8"), 0x1);
  }

  close(): void {
    this.socket.end();
  }

  private handleData(chunk: Buffer): void {
    this.chunks.push(chunk);
    let buffer = Buffer.concat(this.chunks);
    this.chunks.length = 0;

    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < offset + 2) break;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) break;
        const high = buffer.readUInt32BE(offset);
        const low = buffer.readUInt32BE(offset + 4);
        offset += 8;
        if (high !== 0) {
          this.close();
          return;
        }
        length = low;
      }

      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) break;

      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      offset += length;
      buffer = buffer.subarray(offset);

      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index] ^ mask[index % 4];
        }
      }

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x1) {
        try {
          const parsed = JSON.parse(payload.toString("utf-8")) as Record<string, unknown>;
          this.onJson(parsed);
        } catch {
          this.onJson({ type: "invalid_json", raw: payload.toString("utf-8") });
        }
      }
      if (opcode === 0x2) {
        this.onBinary(payload);
      }
    }

    if (buffer.length > 0) {
      this.chunks.push(buffer);
    }
  }

  private sendFrame(payload: Buffer, opcode: number): void {
    const header: number[] = [0x80 | opcode];
    if (payload.length < 126) {
      header.push(payload.length);
    } else if (payload.length <= 0xffff) {
      header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
    } else {
      header.push(127, 0, 0, 0, 0);
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(payload.length, 0);
      header.push(...length);
    }
    this.socket.write(Buffer.concat([Buffer.from(header), payload]));
  }
}

class EchoRealtimeProcessor extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";

  start(): void {
    if (this.child) {
      return;
    }
    const python = resolveWorkerPython();
    const env = {
      ...process.env,
      ...caBundleEnv(),
      PYTHONPATH: path.join(appRoot, "src"),
      PYTHOS_CONFIG: path.join(appRoot, "config.json")
    };
    const child = spawn(
      python,
      ["-m", "pythos.echo_realtime_worker", "--config", path.join(appRoot, "config.json")],
      { cwd: appRoot, env, stdio: "pipe" }
    );
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        this.emit("event", { type: "debug", payload: { text } });
      }
    });
    child.on("exit", (code) => {
      this.emit("event", { type: "exit", payload: { code } });
      if (this.child === child) {
        this.child = null;
      }
    });
  }

  pushAudio(data: Buffer): void {
    this.start();
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      return;
    }
    child.stdin.write(`${JSON.stringify({ type: "audio", data: data.toString("base64") })}\n`);
  }

  wake(): void {
    this.send({ type: "wake" });
  }

  reset(): void {
    this.send({ type: "reset" });
  }

  stop(): void {
    this.send({ type: "shutdown" });
    this.child?.kill();
    this.child = null;
  }

  private send(value: Record<string, unknown>): void {
    this.start();
    const child = this.child;
    if (child && !child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    }
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        try {
          this.emit("event", JSON.parse(line));
        } catch {
          this.emit("event", { type: "error", payload: { source: "echo-realtime-json", message: line } });
        }
      }
      index = this.buffer.indexOf("\n");
    }
  }
}

export class EchoBridge extends EventEmitter {
  private readonly port: number;
  private readonly publicHost: string;
  private readonly onPrompt: EchoBridgeOptions["onPrompt"];
  private readonly eventCallback?: EchoBridgeOptions["onEvent"];
  private readonly sockets = new Set<EchoSocket>();
  private readonly socketDevices = new Map<EchoSocket, string>();
  private readonly socketDeviceNames = new Map<EchoSocket, string>();
  private readonly realtime = new EchoRealtimeProcessor();
  private activeDeviceId = "echo-node";
  private activeDeviceName = "Alexa";
  private activeSessionId = "";
  private handlingRealtimePrompt = false;
  private lastRealtimeAudioLevelAt = 0;
  private server: http.Server | null = null;
  private readonly tmpDir = path.join(appRoot, ".echo-node");
  private readonly fileDir = path.join(this.tmpDir, "files");
  private readonly uploadDir = path.join(this.tmpDir, "uploads");

  constructor(options: EchoBridgeOptions) {
    super();
    this.port = options.port ?? Number(process.env.PYTHOS_ECHO_PORT ?? 9000);
    this.publicHost = process.env.PYTHOS_ECHO_HOST ?? findLanAddress();
    this.onPrompt = options.onPrompt;
    this.eventCallback = options.onEvent;
    this.realtime.on("event", (event) => {
      void this.handleRealtimeEvent(event as { type: string; payload?: Record<string, unknown> });
    });
  }

  get wsUrl(): string {
    return `ws://${this.publicHost}:${this.port}/echo`;
  }

  get uploadUrl(): string {
    return `http://${this.publicHost}:${this.port}/api/audio/request`;
  }

  start(): void {
    if (this.server) {
      return;
    }
    fs.mkdirSync(this.fileDir, { recursive: true });
    fs.mkdirSync(this.uploadDir, { recursive: true });
    this.realtime.start();
    this.server = http.createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.server.on("upgrade", (request, socket) => this.handleUpgrade(request, socket));
    this.server.listen(this.port, "0.0.0.0", () => {
      this.emitEvent({
        type: "listening",
        payload: {
          url: `http://${this.publicHost}:${this.port}`,
          uploadUrl: this.uploadUrl,
          wsUrl: this.wsUrl
        }
      });
    });
    this.server.on("error", (error) => {
      this.emitError("server", String(error));
    });
  }

  stop(): void {
    for (const socket of this.sockets) {
      socket.close();
    }
    this.sockets.clear();
    this.realtime.stop();
    this.server?.close();
    this.server = null;
  }

  sendCommand(command: Record<string, unknown>): void {
    for (const socket of this.sockets) {
      socket.sendJson(command);
    }
  }

  setLed(pattern: string, brightness = 80): void {
    this.sendCommand({ type: "led", pattern, brightness });
  }

  requestRecord(seconds = 5): void {
    this.sendCommand({ type: "record", seconds });
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setCors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const host = requestHost(request, `${this.publicHost}:${this.port}`);
      this.json(response, 200, {
        ok: true,
        wsUrl: `ws://${host}/echo`,
        uploadUrl: `http://${host}/api/audio/request`,
        textUrl: `http://${host}/api/text/request`,
        clients: this.sockets.size
      });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/files/")) {
      this.serveFile(url.pathname.slice("/files/".length), response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/audio/request") {
      await this.handleAudioRequest(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/text/request") {
      await this.handleTextRequest(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/device/event") {
      await this.handleDeviceEventRequest(request, response);
      return;
    }

    this.json(response, 404, { error: "Not found" });
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/echo") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n"
      ].join("\r\n")
    );
    let echoSocket: EchoSocket;
    echoSocket = new EchoSocket(
      socket,
      (value) => this.handleSocketJson(echoSocket, value),
      (data) => this.handleSocketBinary(echoSocket, data),
      () => this.handleSocketClose(echoSocket)
    );
    const deviceId = normalizeDeviceId(url.searchParams.get("deviceId"), "echo-node");
    const sessionId = normalizeOptionalString(url.searchParams.get("sessionId"));
    const deviceName =
      firstNonEmptyString(
        url.searchParams.get("deviceName"),
        url.searchParams.get("name"),
        url.searchParams.get("label")
      ) || defaultEchoDeviceName(deviceId);
    this.sockets.add(echoSocket);
    this.socketDevices.set(echoSocket, deviceId);
    this.socketDeviceNames.set(echoSocket, deviceName);
    this.activeDeviceId = deviceId;
    this.activeSessionId = sessionId;
    this.activeDeviceName = deviceName;
    this.emitEvent({
      type: "device_event",
      payload: { type: "online", deviceId, sessionId, deviceName, transport: "websocket" }
    });
    echoSocket.sendJson({ type: "config", uploadUrl: this.uploadUrl });
    echoSocket.sendJson({ type: "led", pattern: "codex-pink", brightness: 30 });
    echoSocket.sendJson({ type: "realtime_start" });
  }

  private handleSocketJson(socket: EchoSocket, value: Record<string, unknown>): void {
    const deviceId = normalizeDeviceId(value.deviceId, this.socketDevices.get(socket) ?? this.activeDeviceId);
    const sessionId = normalizeOptionalString(value.sessionId) || this.activeSessionId;
    const deviceName =
      firstNonEmptyString(value.deviceName, value.name, value.label, value.friendlyName) ||
      this.socketDeviceNames.get(socket) ||
      defaultEchoDeviceName(deviceId);
    const eventType = normalizeOptionalString(value.type) || "status";
    const eventPayload = {
      ...value,
      type: eventType,
      deviceId,
      sessionId,
      deviceName
    };

    this.activeDeviceId = deviceId;
    this.activeSessionId = sessionId;
    this.activeDeviceName = deviceName;
    this.socketDevices.set(socket, deviceId);
    this.socketDeviceNames.set(socket, deviceName);
    if (this.handleSocketJsonAudio(eventPayload)) {
      return;
    }
    this.emitEvent({ type: "device_event", payload: eventPayload });
    if (eventType === "wake") {
      socket.sendJson({ type: "led", pattern: "active-listening", brightness: 80 });
      this.realtime.wake();
    }
    if (eventType === "online") {
      socket.sendJson({ type: "config", uploadUrl: this.uploadUrl });
      socket.sendJson({ type: "led", pattern: "codex-pink", brightness: 30 });
      socket.sendJson({ type: "realtime_start" });
    }
  }

  private handleSocketClose(socket: EchoSocket): void {
    this.sockets.delete(socket);
    const deviceId = this.socketDevices.get(socket);
    const deviceName = this.socketDeviceNames.get(socket);
    this.socketDevices.delete(socket);
    this.socketDeviceNames.delete(socket);
    if (deviceId) {
      this.emitEvent({ type: "device_event", payload: { type: "offline", deviceId, deviceName } });
    }
  }

  private handleSocketBinary(socket: EchoSocket, data: Buffer): void {
    this.activeDeviceId = this.socketDevices.get(socket) ?? this.activeDeviceId;
    this.activeDeviceName = this.socketDeviceNames.get(socket) ?? "";
    this.realtime.pushAudio(data);
  }

  private handleSocketJsonAudio(value: Record<string, unknown>): boolean {
    const type = String(value.type ?? "");
    if (type !== "audio" && type !== "audio_chunk" && type !== "realtime_audio") {
      return false;
    }
    const encoded = [value.data, value.audio, value.chunk].find((candidate) => typeof candidate === "string");
    if (typeof encoded !== "string" || !encoded.trim()) {
      this.emitError("echo-audio", "Audio JSON frame did not include base64 data, audio, or chunk.");
      return true;
    }
    try {
      this.realtime.pushAudio(Buffer.from(encoded, "base64"));
    } catch (error) {
      this.emitError("echo-audio", `Could not decode audio JSON frame: ${String(error)}`);
    }
    return true;
  }

  private async handleRealtimeEvent(event: { type: string; payload?: Record<string, unknown> }): Promise<void> {
    const payload = event.payload ?? {};
    if (event.type === "audio_level") {
      const now = Date.now();
      if (now - this.lastRealtimeAudioLevelAt < 500) {
        return;
      }
      this.lastRealtimeAudioLevelAt = now;
    }
    this.emitEvent({
      type: "realtime_state",
      payload: {
        ...payload,
        type: event.type,
        deviceId: this.activeDeviceId,
        sessionId: this.activeSessionId,
        deviceName: this.activeDeviceName || defaultEchoDeviceName(this.activeDeviceId)
      }
    });
    if (event.type === "state") {
      const value = String(payload.value ?? "");
      if (value === "wakeword") {
        this.setLed("codex-pink", 30);
      }
      if (value === "listening") {
        this.setLed("active-listening", 80);
      }
    }
    if (event.type === "wake") {
      this.setLed("active-listening", 80);
    }
    if (event.type === "final_transcript") {
      const transcript = String(payload.text ?? "").trim();
      if (transcript) {
        await this.handleRealtimeTranscript(transcript);
      }
    }
    if (event.type === "error") {
      this.emitError("echo-realtime", String(payload.message ?? "Realtime worker error"));
    }
  }

  private async handleRealtimeTranscript(transcript: string): Promise<void> {
    if (this.handlingRealtimePrompt) {
      return;
    }
    this.handlingRealtimePrompt = true;
    const deviceId = this.activeDeviceId;
    const sessionId = this.activeSessionId;
    const deviceName = this.activeDeviceName || undefined;
    try {
      this.emitEvent({
        type: "transcript",
        payload: { deviceId, sessionId, deviceName, text: transcript }
      });
      this.setLed("active-thinking", 80);
      const reply = normalizePromptReply(await this.onPrompt({
        deviceId,
        sessionId,
        transcript,
        deviceName,
        source: "realtime"
      }));
      const { audioUrl, bytes } = await this.createReplyAudio(reply.text, `${this.publicHost}:${this.port}`);
      this.setLed("active-talking", 80);
      this.sendCommand({
        type: "play_audio",
        url: audioUrl,
        toolUsed: reply.toolUsed,
        volume: echoPlaybackVolume,
        streamVolume: echoStreamVolume
      });
      this.emitEvent({
        type: "reply",
        payload: { deviceId, sessionId, deviceName, text: reply.text, audioUrl }
      });
      this.emitEvent({
        type: "device_event",
        payload: {
          type: "tts_play_requested",
          deviceId,
          sessionId,
          deviceName,
          url: audioUrl,
          bytes,
          toolUsed: reply.toolUsed,
          volume: echoPlaybackVolume,
          streamVolume: echoStreamVolume
        }
      });
      setTimeout(() => {
        this.setLed("codex-pink", 30);
        this.emitEvent({
          type: "device_event",
          payload: { type: "idle", deviceId, sessionId, deviceName }
        });
      }, 1500);
    } finally {
      this.handlingRealtimePrompt = false;
      this.realtime.reset();
    }
  }

  private async handleAudioRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const upload = parseMultipart(await readRequestBody(request), request.headers["content-type"]);
      this.emitEvent({
        type: "upload_started",
        payload: { deviceId: upload.deviceId, sessionId: upload.sessionId, deviceName: upload.deviceName }
      });
      this.setLed("active-thinking");
      const uploadPath = path.join(this.uploadDir, `${Date.now()}-${safeName(upload.fileName || "echo.wav")}`);
      fs.writeFileSync(uploadPath, upload.file);
      const transcript = await this.transcribe(uploadPath);
      this.emitEvent({
        type: "transcript",
        payload: { deviceId: upload.deviceId, sessionId: upload.sessionId, deviceName: upload.deviceName, text: transcript }
      });

      if (!transcript) {
        this.setLed("solid_red");
        this.json(response, 200, { text: "", message: "No speech detected" });
        return;
      }

      const reply = normalizePromptReply(await this.onPrompt({
        deviceId: upload.deviceId,
        sessionId: upload.sessionId,
        transcript,
        deviceName: upload.deviceName,
        source: "audio"
      }));
      const { audioUrl, bytes } = await this.createReplyAudio(
        reply.text,
        requestHost(request, `${this.publicHost}:${this.port}`)
      );
      this.setLed("active-talking");
      this.emitEvent({
        type: "reply",
        payload: {
          deviceId: upload.deviceId,
          sessionId: upload.sessionId,
          deviceName: upload.deviceName,
          text: reply.text,
          audioUrl
        }
      });
      this.emitEvent({
        type: "device_event",
        payload: {
          type: "tts_play_requested",
          deviceId: upload.deviceId,
          sessionId: upload.sessionId,
          deviceName: upload.deviceName,
          url: audioUrl,
          bytes,
          toolUsed: reply.toolUsed,
          volume: echoPlaybackVolume,
          streamVolume: echoStreamVolume
        }
      });
      this.json(response, 200, {
        text: reply.text,
        audioUrl,
        fileUrl: audioUrl,
        toolUsed: reply.toolUsed,
        volume: echoPlaybackVolume,
        streamVolume: echoStreamVolume
      });
      setTimeout(() => {
        this.setLed("codex-pink", 30);
        this.emitEvent({
          type: "device_event",
          payload: { type: "idle", deviceId: upload.deviceId, sessionId: upload.sessionId, deviceName: upload.deviceName }
        });
      }, 750);
    } catch (error) {
      this.setLed("solid_red");
      this.emitError("audio-request", String(error));
      this.json(response, 500, { error: String(error) });
    }
  }

  private async handleTextRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const payload = parseTextRequest(await readJsonRequest(request));
      this.emitEvent({
        type: "device_event",
        payload: {
          type: "text_request",
          deviceId: payload.deviceId,
          sessionId: payload.sessionId,
          deviceName: payload.deviceName
        }
      });
      this.emitEvent({
        type: "transcript",
        payload: {
          deviceId: payload.deviceId,
          sessionId: payload.sessionId,
          deviceName: payload.deviceName,
          text: payload.text
        }
      });

      this.setLed("active-thinking");
      const reply = normalizePromptReply(await this.onPrompt({
        deviceId: payload.deviceId,
        sessionId: payload.sessionId,
        deviceName: payload.deviceName,
        transcript: payload.text,
        source: "text"
      }));
      const { audioUrl, bytes } = await this.createReplyAudio(
        reply.text,
        requestHost(request, `${this.publicHost}:${this.port}`)
      );
      this.setLed("active-talking");
      this.emitEvent({
        type: "reply",
        payload: {
          deviceId: payload.deviceId,
          sessionId: payload.sessionId,
          deviceName: payload.deviceName,
          text: reply.text,
          audioUrl
        }
      });
      this.emitEvent({
        type: "device_event",
        payload: {
          type: "tts_play_requested",
          deviceId: payload.deviceId,
          sessionId: payload.sessionId,
          deviceName: payload.deviceName,
          url: audioUrl,
          bytes,
          toolUsed: reply.toolUsed,
          volume: echoPlaybackVolume,
          streamVolume: echoStreamVolume
        }
      });
      this.json(response, 200, {
        text: reply.text,
        audioUrl,
        fileUrl: audioUrl,
        toolUsed: reply.toolUsed,
        volume: echoPlaybackVolume,
        streamVolume: echoStreamVolume
      });
      setTimeout(() => {
        this.setLed("codex-pink", 30);
        this.emitEvent({
          type: "device_event",
          payload: {
            type: "idle",
            deviceId: payload.deviceId,
            sessionId: payload.sessionId,
            deviceName: payload.deviceName
          }
        });
      }, 750);
    } catch (error) {
      this.setLed("solid_red");
      this.emitError("text-request", String(error));
      this.json(response, 500, { error: String(error) });
    }
  }

  private async handleDeviceEventRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const payload = await readJsonRequest(request);
      const deviceId = normalizeDeviceId(payload.deviceId, defaultDeviceIdForPayload(payload, "android-phone"));
      const deviceName =
        firstNonEmptyString(payload.deviceName, payload.name, payload.label, payload.friendlyName) ||
        defaultDeviceNameForId(deviceId);
      const sessionId = normalizeOptionalString(payload.sessionId);
      const eventType = normalizeOptionalString(payload.type) || "heartbeat";
      this.emitEvent({
        type: "device_event",
        payload: {
          type: eventType,
          deviceId,
          sessionId,
          deviceName,
          at: new Date().toISOString()
        }
      });
      const host = requestHost(request, `${this.publicHost}:${this.port}`);
      this.json(response, 200, {
        ok: true,
        wsUrl: `ws://${host}/echo`,
        uploadUrl: `http://${host}/api/audio/request`,
        textUrl: `http://${host}/api/text/request`
      });
    } catch (error) {
      this.emitError("device-event", String(error));
      this.json(response, 500, { error: String(error) });
    }
  }

  private async createReplyAudio(text: string, host: string): Promise<{ audioUrl: string; bytes: number }> {
    const fileName = `reply-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.wav`;
    const audioPath = path.join(this.fileDir, fileName);
    await this.synthesize(text, audioPath);
    return {
      bytes: fs.statSync(audioPath).size,
      audioUrl: `http://${host}/files/${fileName}`
    };
  }

  private serveFile(fileName: string, response: ServerResponse): void {
    const safe = safeName(decodeURIComponent(fileName));
    const filePath = path.join(this.fileDir, safe);
    if (!filePath.startsWith(this.fileDir) || !fs.existsSync(filePath)) {
      this.json(response, 404, { error: "File not found" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "audio/wav",
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(response);
  }

  private transcribe(inputPath: string): Promise<string> {
    return runPythonJson([
      "-m",
      "pythos.echo_tools",
      "--config",
      path.join(appRoot, "config.json"),
      "transcribe",
      "--input",
      inputPath
    ]).then((value) => String(value.text ?? "").trim());
  }

  private synthesize(text: string, outputPath: string): Promise<void> {
    return runPythonJson([
      "-m",
      "pythos.echo_tools",
      "--config",
      path.join(appRoot, "config.json"),
      "synthesize",
      "--text",
      text,
      "--output",
      outputPath
    ]).then(() => undefined);
  }

  private json(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  }

  private emitEvent(event: EchoBridgeEvent): void {
    this.eventCallback?.(event);
    this.emit("event", event);
  }

  private emitError(source: string, message: string): void {
    this.emitEvent({ type: "error", payload: { source, message } });
  }
}

function runPythonJson(args: string[]): Promise<Record<string, unknown>> {
  const python = resolveWorkerPython();
  const env = {
    ...process.env,
    ...caBundleEnv(),
    PYTHONPATH: path.join(appRoot, "src"),
    PYTHOS_CONFIG: path.join(appRoot, "config.json")
  };

  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd: appRoot, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Python helper exited with ${String(code)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`Python helper returned invalid JSON: ${String(error)} ${stdout}`));
      }
    });
  });
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readRequestBody(request);
  if (body.length === 0) {
    return {};
  }
  const parsed = JSON.parse(body.toString("utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object request body.");
  }
  return parsed as Record<string, unknown>;
}

function parseTextRequest(payload: Record<string, unknown>): RemoteTextRequest {
  const text = normalizeOptionalString(payload.text);
  if (!text) {
    throw new Error("Missing text prompt.");
  }
  const deviceId = normalizeDeviceId(payload.deviceId, defaultDeviceIdForPayload(payload, "android-phone"));
  return {
    deviceId,
    sessionId: normalizeOptionalString(payload.sessionId) || crypto.randomUUID(),
    deviceName:
      firstNonEmptyString(payload.deviceName, payload.name, payload.label, payload.friendlyName) ||
      defaultDeviceNameForId(deviceId) ||
      undefined,
    text
  };
}

function normalizePromptReply(reply: EchoPromptReply): NormalizedEchoPromptReply {
  if (typeof reply === "string") {
    return { text: reply, toolUsed: false };
  }
  return {
    text: String(reply.text ?? ""),
    toolUsed: Boolean(reply.toolUsed)
  };
}

function parseMultipart(body: Buffer, contentType: string | string[] | undefined): ParsedUpload {
  const type = Array.isArray(contentType) ? contentType[0] : contentType ?? "";
  const boundaryMatch = /boundary=([^;]+)/i.exec(type);
  if (!boundaryMatch) {
    throw new Error("Missing multipart boundary");
  }
  const boundary = `--${boundaryMatch[1].replace(/^"|"$/g, "")}`;
  const parts = body.toString("latin1").split(boundary);
  const fields = new Map<string, string>();
  let file = Buffer.alloc(0);
  let fileName = "echo.wav";

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const header = part.slice(0, headerEnd);
    let payload = part.slice(headerEnd + 4);
    payload = payload.replace(/\r\n--$/, "").replace(/\r\n$/, "");
    const name = /name="([^"]+)"/i.exec(header)?.[1];
    if (!name) continue;
    if (/filename="/i.test(header)) {
      fileName = /filename="([^"]*)"/i.exec(header)?.[1] || fileName;
      file = Buffer.from(payload, "latin1");
    } else {
      fields.set(name, payload.trim());
    }
  }

  if (file.length === 0) {
    throw new Error("Multipart upload did not include file");
  }

  const deviceId = fields.get("deviceId") || "echo-node";
  return {
    deviceId,
    sessionId: fields.get("sessionId") || "",
    deviceName: fields.get("deviceName") || fields.get("name") || defaultDeviceNameForId(deviceId) || undefined,
    fileName,
    file
  };
}

function requestHost(request: IncomingMessage, fallback: string): string {
  return normalizeOptionalString(request.headers.host) || fallback;
}

function normalizeDeviceId(value: unknown, fallback: string): string {
  return normalizeOptionalString(value) || fallback;
}

function defaultDeviceIdForPayload(payload: Record<string, unknown>, fallback: string): string {
  const identity = firstNonEmptyString(
    payload.source,
    payload.deviceType,
    payload.platform,
    payload.deviceName,
    payload.name,
    payload.label,
    payload.friendlyName
  );
  if (/alexa|echo/i.test(identity)) {
    return "echo-node";
  }
  return fallback;
}

function defaultEchoDeviceName(deviceId: string): string {
  return /alexa|echo/i.test(deviceId) ? "Alexa" : "Echo";
}

function defaultDeviceNameForId(deviceId: string): string {
  return /alexa|echo/i.test(deviceId) ? "Alexa" : "";
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text = normalizeOptionalString(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeName(value: string): string {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function setCors(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function findLanAddress(): string {
  const candidates: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        candidates.push(address.address);
      }
    }
  }
  return (
    candidates.find((address) => address.startsWith("192.168.")) ??
    candidates.find((address) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) ??
    candidates.find((address) => address.startsWith("10.")) ??
    candidates.find((address) => !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) ??
    "127.0.0.1"
  );
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}
