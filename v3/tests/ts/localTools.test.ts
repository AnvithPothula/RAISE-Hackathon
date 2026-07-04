import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractLocationFromPrompt,
  resolveContextualLocalTool,
  resolveDirectLocalTool,
  runNamedLocalTool
} from "../../src/main/localTools";

function writeSpotifyToken(clientId = "client-123"): string {
  const tokenPath = path.join(os.tmpdir(), `spotify-token-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({ client_id: clientId, redirect_uri: "http://127.0.0.1:8888/callback", access_token: "token" }),
    "utf-8"
  );
  return tokenPath;
}

describe("extractLocationFromPrompt", () => {
  it("finds a requested weather location after for", () => {
    expect(extractLocationFromPrompt("current weather for la paz")).toBe("la paz");
  });

  it("strips polite trailing words and punctuation", () => {
    expect(extractLocationFromPrompt("what is the weather in paris please?")).toBe("paris");
  });
});

describe("runNamedLocalTool", () => {
  it("does not silently use remembered location when an explicit weather location fails", async () => {
    await expect(
      runNamedLocalTool("weather", { location: "zzzz definitely not a real city" }, "Eagan, Minnesota")
    ).rejects.toThrow(/zzzz definitely not a real city/i);
  });

  it("uses the website opener service with normalized domains", async () => {
    const opened: string[] = [];

    await runNamedLocalTool("open_website", { url: "youtube" }, null, {
      openWebsite: async (url) => {
        opened.push(url);
      }
    });

    expect(opened).toEqual(["https://youtube.com/"]);
  });

  it("uses the app opener service with common app aliases", async () => {
    const opened: string[] = [];

    await runNamedLocalTool("open_app", { app: "calculator" }, null, {
      openApp: async (app) => {
        opened.push(app);
      }
    });

    const expected = process.platform === "darwin" ? "Calculator" : process.platform === "win32" ? "calc.exe" : "gnome-calculator";
    expect(opened).toEqual([expected]);
  });

  it("uses app aliases for Excel and Notes", async () => {
    const opened: string[] = [];

    await runNamedLocalTool("open_app", { app: "excel" }, null, {
      openApp: async (app) => {
        opened.push(app);
      }
    });
    await runNamedLocalTool("open_app", { app: "notes" }, null, {
      openApp: async (app) => {
        opened.push(app);
      }
    });

    const expected =
      process.platform === "darwin"
        ? ["Microsoft Excel", "Notes"]
        : process.platform === "win32"
          ? ["excel.exe", "notepad.exe"]
          : ["excel", "gedit"];
    expect(opened).toEqual(expected);
  });

  it("uses injected web search service", async () => {
    const result = await runNamedLocalTool("web_search", { query: "pythos" }, null, {
      webSearch: async (query) => ({
        fetchedAt: "fetched-fixture",
        results: [{ title: `Result for ${query}`, url: "https://example.com", snippet: "Example snippet" }]
      })
    });

    expect(result.query).toBe("pythos");
    expect(result.fetchedAt).toBe("fetched-fixture");
    expect(result.text).toContain("https://example.com");
  });

  it("uses injected geocode and forecast services for weather", async () => {
    const result = await runNamedLocalTool("weather", { location: "test city" }, null, {
      geocode: async () => ({
        name: "Test City",
        admin1: "Test State",
        country: "US",
        latitude: 1,
        longitude: 2,
        timezone: "America/Chicago"
      }),
      forecast: async () => ({
        current: {
          temperature_2m: 72,
          apparent_temperature: 70,
          relative_humidity_2m: 45,
          precipitation: 0,
          weather_code: 0,
          wind_speed_10m: 6
        }
      })
    });

    expect(result.text).toContain("Current weather in Test City, Test State, US");
    expect(result.text).toContain("72 degrees Fahrenheit");
  });

  it("uses injected clock and timer services for alarms", async () => {
    let scheduledDelay = -1;
    const fakeTimer = {} as ReturnType<typeof setTimeout>;

    const result = await runNamedLocalTool("alarm", { action: "set", time: "in 5 minutes", label: "test" }, null, {
      now: () => 1_000,
      setTimeout: (_callback, delayMs) => {
        scheduledDelay = delayMs;
        return fakeTimer;
      }
    });

    expect(scheduledDelay).toBe(300_000);
    expect(result.text).toContain("Set alarm alarm-rs");
  });

  it("uses injected user memory service", async () => {
    const result = await runNamedLocalTool("memory", { action: "add", text: "The user is an engineer.", category: "profile" }, null, {
      userMemory: {
        remember: ({ text, category }) => ({
          id: "mem-1",
          text,
          category: category === "profile" ? "profile" : "other",
          createdAt: "created-fixture",
          updatedAt: "updated-fixture"
        }),
        forget: () => null,
        list: () => [],
        summary: () => ""
      }
    });

    expect(result.text).toBe("Remembered profile: The user is an engineer.");
  });

  it("maps Spotify song playback to the spotify-control skill", async () => {
    const calls: unknown[] = [];
    const tokenCache = writeSpotifyToken();

    const result = await runNamedLocalTool("spotify", { action: "play", query: "wasn't real", kind: "track" }, null, {
      spotify: { clientId: "client-123", tokenCache },
      runSkillScript: async (args) => {
        calls.push(args);
        return {
          name: "skill_script",
          text: "Playing wasn't real.",
          skillName: String(args.skillName),
          script: String(args.script)
        };
      }
    });

    expect(calls).toEqual([
      {
        skillName: "spotify-control",
        script: "scripts/spotify_control.py",
        args: ["--client-id", "client-123", "--token-cache", tokenCache, "play", "--query", "wasn't real", "--kind", "track"]
      }
    ]);
    expect(result.name).toBe("spotify");
    expect(result.text).toBe("Playing wasn't real.");
  });

  it("maps Spotify volume with a target device", async () => {
    const calls: unknown[] = [];
    const tokenCache = writeSpotifyToken();

    await runNamedLocalTool("spotify", { action: "volume", percent: 35, deviceName: "Desk speakers" }, null, {
      spotify: { clientId: "client-123", tokenCache },
      runSkillScript: async (args) => {
        calls.push(args);
        return { name: "skill_script", text: "Volume set.", skillName: "spotify-control", script: "scripts/spotify_control.py" };
      }
    });

    expect(calls).toEqual([
      {
        skillName: "spotify-control",
        script: "scripts/spotify_control.py",
        args: ["--client-id", "client-123", "--token-cache", tokenCache, "volume", "--percent", "35", "--device-name", "Desk speakers"]
      }
    ]);
  });

  it("passes Spotify auth config before the command", async () => {
    const calls: unknown[] = [];

    await runNamedLocalTool("spotify", { action: "login" }, null, {
      spotify: { clientId: "client-123", redirectUri: "http://127.0.0.1:8888/callback" },
      runSkillScript: async (args) => {
        calls.push(args);
        return { name: "skill_script", text: "Logged in.", skillName: "spotify-control", script: "scripts/spotify_control.py" };
      }
    });

    expect(calls).toEqual([
      {
        skillName: "spotify-control",
        script: "scripts/spotify_control.py",
        args: ["--client-id", "client-123", "--redirect-uri", "http://127.0.0.1:8888/callback", "login"]
      }
    ]);
  });

  it("rewrites Spotify invalid_client failures into setup guidance", async () => {
    const tokenCache = writeSpotifyToken();
    const result = await runNamedLocalTool("spotify", { action: "play", query: "prom queen", kind: "track" }, null, {
      spotify: { clientId: "client-123", tokenCache },
      runSkillScript: async () => ({
        name: "skill_script",
        text: 'Spotify API error 400: {"error":"invalid_client"}',
        skillName: "spotify-control",
        script: "scripts/spotify_control.py"
      })
    });

    expect(result.text).toContain("Spotify rejected the configured client ID");
  });

  it("rewrites Spotify helper tracebacks into a short failure", async () => {
    const tokenCache = writeSpotifyToken();
    const result = await runNamedLocalTool("spotify", { action: "pause" }, null, {
      spotify: { clientId: "client-123", tokenCache },
      runSkillScript: async () => ({
        name: "skill_script",
        text:
          "\u001b[35mTraceback (most recent call last):\u001b[0m\n" +
          'File "C:\\Users\\Scuyul\\.codex\\skills\\spotify-control\\scripts\\spotify_control.py", line 239, in api\n' +
          "json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
        skillName: "spotify-control",
        script: "scripts/spotify_control.py"
      })
    });

    expect(result.text).toContain("Spotify command failed inside the Spotify helper");
    expect(result.text).not.toContain("Traceback");
    expect(result.text).not.toContain("[35m");
    expect(result.text).not.toContain("spotify_control.py");
  });

  it("rewrites successful Spotify command JSON into concise confirmations", async () => {
    const tokenCache = writeSpotifyToken();
    const result = await runNamedLocalTool("spotify", { action: "pause" }, null, {
      spotify: { clientId: "client-123", tokenCache },
      runSkillScript: async () => ({
        name: "skill_script",
        text: '{ "ok": true, "status": 204 }',
        skillName: "spotify-control",
        script: "scripts/spotify_control.py"
      })
    });

    expect(result.text).toBe("Paused Spotify.");
  });

  it("rewrites Spotify Premium playback errors", async () => {
    const tokenCache = writeSpotifyToken();
    const result = await runNamedLocalTool("spotify", { action: "pause" }, null, {
      spotify: { clientId: "client-123", tokenCache },
      runSkillScript: async () => ({
        name: "skill_script",
        text: 'Spotify API error 403: {"error":{"status":403,"message":"Player command failed: Premium required"}}',
        skillName: "spotify-control",
        script: "scripts/spotify_control.py"
      })
    });

    expect(result.text).toBe(
      "Spotify rejected the command: Premium required. Spotify Web API playback control requires Spotify Premium."
    );
  });

  it("runs login before playback when the token cache belongs to a different client", async () => {
    const tokenCache = writeSpotifyToken("old-client");
    const calls: unknown[] = [];

    const result = await runNamedLocalTool("spotify", { action: "play", query: "prom queen", kind: "track" }, null, {
      spotify: { clientId: "client-123", tokenCache },
      runSkillScript: async (args) => {
        calls.push(args);
        const scriptArgs = args.args as string[];
        if (scriptArgs.includes("login")) {
          fs.writeFileSync(
            tokenCache,
            JSON.stringify({
              client_id: "client-123",
              redirect_uri: "http://127.0.0.1:8888/callback",
              access_token: "new-token"
            }),
            "utf-8"
          );
          return { name: "skill_script", text: "Logged in.", skillName: "spotify-control", script: "scripts/spotify_control.py" };
        }
        return { name: "skill_script", text: "Playing prom queen.", skillName: "spotify-control", script: "scripts/spotify_control.py" };
      }
    });

    expect(calls).toEqual([
      {
        skillName: "spotify-control",
        script: "scripts/spotify_control.py",
        args: ["--client-id", "client-123", "--token-cache", tokenCache, "login"]
      },
      {
        skillName: "spotify-control",
        script: "scripts/spotify_control.py",
        args: ["--client-id", "client-123", "--token-cache", tokenCache, "play", "--query", "prom queen", "--kind", "track"]
      }
    ]);
    expect(result.text).toBe("Playing prom queen.");
  });

  it("does not try Spotify login without a client id", async () => {
    const calls: unknown[] = [];

    const result = await runNamedLocalTool("spotify", { action: "play", query: "prom queen", kind: "track" }, null, {
      spotify: { tokenCache: path.join(os.tmpdir(), `missing-token-${Date.now()}.json`) },
      runSkillScript: async (args) => {
        calls.push(args);
        return { name: "skill_script", text: "Should not run.", skillName: "spotify-control", script: "scripts/spotify_control.py" };
      }
    });

    expect(calls).toEqual([]);
    expect(result.text).toContain("Spotify needs a client ID");
  });
});

describe("resolveDirectLocalTool", () => {
  it("routes explicit known app launch commands without model help", () => {
    expect(resolveDirectLocalTool("open excel")).toEqual({ name: "open_app", args: { app: "excel" } });
    expect(resolveDirectLocalTool("please launch notes")).toEqual({ name: "open_app", args: { app: "notes" } });
    expect(resolveDirectLocalTool("open excel please")).toEqual({ name: "open_app", args: { app: "excel" } });
    expect(resolveDirectLocalTool("Open Discord")).toEqual({ name: "open_app", args: { app: "Discord" } });
    expect(resolveDirectLocalTool("open slack")).toEqual({ name: "open_app", args: { app: "slack" } });
  });

  it("handles filler words like 'open up X' and 'launch my X'", () => {
    expect(resolveDirectLocalTool("open up chrome")).toEqual({ name: "open_app", args: { app: "chrome" } });
    expect(resolveDirectLocalTool("Open up Chrome.")).toEqual({ name: "open_app", args: { app: "Chrome" } });
    expect(resolveDirectLocalTool("launch my calculator")).toEqual({ name: "open_app", args: { app: "calculator" } });
    expect(resolveDirectLocalTool("pull up spotify")).toEqual({ name: "open_app", args: { app: "spotify" } });
  });

  it("routes explicit website launch commands without model help", () => {
    expect(resolveDirectLocalTool("open youtube")).toEqual({ name: "open_website", args: { url: "youtube" } });
    expect(resolveDirectLocalTool("open example.com")).toEqual({ name: "open_website", args: { url: "example.com" } });
  });

  it("routes weather and time questions without model help", () => {
    expect(resolveDirectLocalTool("How is the weather like in Eagan, MN?")).toEqual({
      name: "weather",
      args: { location: "Eagan, MN" }
    });
    expect(resolveDirectLocalTool("what's the weather in Boston")).toEqual({
      name: "weather",
      args: { location: "Boston" }
    });
    expect(resolveDirectLocalTool("what time is it in Tokyo")).toEqual({
      name: "time",
      args: { location: "Tokyo" }
    });
    expect(resolveDirectLocalTool("what time is it")).toEqual({ name: "time", args: {} });
  });

  it("routes Spotify playback controls without model help", () => {
    expect(resolveDirectLocalTool("play people pleaser on spotify")).toEqual({
      name: "spotify",
      args: { action: "play", query: "people pleaser", kind: "track" }
    });
    expect(resolveDirectLocalTool("skip this song on spotify")).toEqual({ name: "spotify", args: { action: "next" } });
    expect(resolveDirectLocalTool("please resume spotify")).toEqual({ name: "spotify", args: { action: "resume" } });
    expect(resolveDirectLocalTool("pause spotify")).toEqual({ name: "spotify", args: { action: "pause" } });
  });

  it("routes Spotify setup and settings commands without model help", () => {
    expect(resolveDirectLocalTool("log in to spotify")).toEqual({ name: "spotify", args: { action: "login" } });
    expect(resolveDirectLocalTool("what's playing on spotify")).toEqual({ name: "spotify", args: { action: "status" } });
    expect(resolveDirectLocalTool("set spotify volume to 35%")).toEqual({
      name: "spotify",
      args: { action: "volume", percent: 35 }
    });
    expect(resolveDirectLocalTool("turn shuffle on spotify off")).toEqual({
      name: "spotify",
      args: { action: "shuffle", state: "false" }
    });
  });

  it("routes media follow-ups to Spotify only after Spotify context", () => {
    expect(resolveDirectLocalTool("please skip this song")).toBeNull();
    expect(resolveContextualLocalTool("please skip this song", null)).toBeNull();
    expect(resolveContextualLocalTool("please skip this song", "spotify")).toEqual({
      name: "spotify",
      args: { action: "next" }
    });
    expect(resolveContextualLocalTool("pause it", "spotify")).toEqual({
      name: "spotify",
      args: { action: "pause" }
    });
    expect(resolveContextualLocalTool("what's playing", "spotify")).toEqual({
      name: "spotify",
      args: { action: "status" }
    });
  });

  it("ignores non-launch prompts", () => {
    expect(resolveDirectLocalTool("what is open source software")).toBeNull();
    expect(resolveDirectLocalTool("open the pod bay doors")).toBeNull();
  });

  it("answers capability questions instantly without the model", () => {
    expect(resolveDirectLocalTool("What can you do?")).toEqual({ name: "capabilities", args: {} });
    expect(resolveDirectLocalTool("what can you do")).toEqual({ name: "capabilities", args: {} });
    expect(resolveDirectLocalTool("what are you capable of")).toEqual({ name: "capabilities", args: {} });
    // Not a capability question — must not hijack.
    expect(resolveDirectLocalTool("what is open source software")).toBeNull();
  });

  it("routes clipboard reads straight to the local clipboard tool", () => {
    expect(resolveDirectLocalTool("What's on my clipboard?")).toEqual({ name: "clipboard", args: {} });
    expect(resolveDirectLocalTool("read my clipboard")).toEqual({ name: "clipboard", args: {} });
    expect(resolveDirectLocalTool("check my clipboard")).toEqual({ name: "clipboard", args: {} });
    // Unrelated prompts must not trigger the clipboard tool.
    expect(resolveDirectLocalTool("what is a clipboard")).not.toEqual({ name: "clipboard", args: {} });
  });

  it("routes screen questions straight to local vision", () => {
    // Trailing punctuation is stripped by the direct-prompt cleaner.
    expect(resolveDirectLocalTool("What's on my screen?")).toEqual({
      name: "screen",
      args: { query: "What's on my screen" }
    });
    expect(resolveDirectLocalTool("read my screen")).toEqual({ name: "screen", args: { query: "read my screen" } });
    expect(resolveDirectLocalTool("what am I looking at")).toEqual({
      name: "screen",
      args: { query: "what am I looking at" }
    });
    // A normal "open" request must not be captured as a screen request.
    expect(resolveDirectLocalTool("open excel")).toEqual({ name: "open_app", args: { app: "excel" } });
  });

  it("routes generic play requests to Spotify without the model", () => {
    expect(resolveDirectLocalTool("Play something relaxing")).toEqual({
      name: "spotify",
      args: { action: "play", kind: "track", query: "something relaxing" }
    });
    expect(resolveDirectLocalTool("play some jazz")).toEqual({
      name: "spotify",
      args: { action: "play", kind: "track", query: "jazz" }
    });
  });
});

describe("capabilities tool", () => {
  it("returns a spoken capability summary with no model call", async () => {
    const result = await runNamedLocalTool("capabilities", {}, null);
    expect(result.name).toBe("capabilities");
    expect(result.text.toLowerCase()).toContain("on-device");
    expect(result.text.toLowerCase()).toContain("open apps");
  });
});
