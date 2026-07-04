import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractLocationFromPrompt,
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

  it("finds a place named earlier in a compound request", () => {
    const prompt =
      "Search finding cool things to do in Albuquerque, then tell me the current weather there.";
    expect(extractLocationFromPrompt(prompt, "Eagan, Minnesota")).toBe("Albuquerque");
  });

  it("stops location capture before a trailing and-clause", () => {
    const prompt = "Find me fun things to do in Albuquerque and tell me the current weather there.";
    expect(extractLocationFromPrompt(prompt, "Eagan, Minnesota")).toBe("Albuquerque");
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

  it("reports unavailable apps honestly instead of claiming success", async () => {
    const result = await runNamedLocalTool("open_app", { app: "Tabroom" }, null, {
      openApp: async () => ({
        opened: false,
        detail: "Tabroom is not installed or not available on this Mac. I couldn't open it."
      })
    });

    expect(result.text).toContain("not installed");
    expect(result.text).not.toMatch(/^Opened /i);
  });

  it("maps Paint aliases to platform handlers", async () => {
    const opened: string[] = [];
    await runNamedLocalTool("open_app", { app: "paint" }, null, {
      openApp: async (target) => {
        opened.push(target);
      }
    });

    if (process.platform === "darwin") {
      expect(opened).toEqual(["Preview"]);
      return;
    }
    if (process.platform === "win32") {
      await runNamedLocalTool("open_app", { app: "Microsoft Paint" }, null, {
        openApp: async (target) => {
          opened.push(target);
        }
      });
      expect(opened).toEqual(["ms-paint:", "ms-paint:"]);
      return;
    }
    expect(opened).toEqual(["paint"]);
  });

  it("returns a failure result when the app opener reports the app was not found", async () => {
    const result = await runNamedLocalTool("open_app", { app: "NonexistentAppXYZ" }, null, {
      openApp: async () => ({
        opened: false,
        detail: "I couldn't find NonexistentAppXYZ on your Mac computer. Check the name or install it first."
      })
    });

    expect(result.name).toBe("open_app");
    expect(result.opened).toBe(false);
    expect(result.text).toContain("couldn't find NonexistentAppXYZ");
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
    expect(result.text).toContain("Result for pythos (example.com)");
    expect(result.text).not.toContain("https://example.com");
    expect(result.text).not.toContain("fetched-fixture");
  });

  it("keeps ambiguous who-is search results concise", async () => {
    const result = await runNamedLocalTool("web_search", { query: "who is Vedansh Karnatha" }, null, {
      webSearch: async () => ({
        fetchedAt: "fetched-fixture",
        results: [
          {
            title: "Vedansh D. - Bengaluru, Karnataka, India - LinkedIn",
            url: "https://in.linkedin.com/in/vedansh-dwivedi",
            snippet: "Location: Bengaluru. 500+ connections on LinkedIn."
          },
          {
            title: "Vedansh Garg - CTO & AI Engineer",
            url: "https://in.linkedin.com/in/vedanshgarg",
            snippet: "Vedansh Garg CTO & AI Engineer in Bengaluru, Karnataka, India."
          },
          {
            title: "Vedansh hails from Kundapura",
            url: "https://www.facebook.com/example",
            snippet: "Vedansh hails from Kundapura, a coastal town in Karnataka."
          }
        ]
      })
    });

    expect(result.text).toContain("possible matches");
    expect(result.text).toContain("nothing clearly identifying Vedansh Karnatha");
    expect(result.text.length).toBeLessThan(260);
    expect(result.text).not.toContain("Source:");
    expect(result.text).not.toContain("https://");
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

  it("adds dated items to Calendar", async () => {
    const now = Date.parse("2026-07-04T16:22:00-05:00");
    let eventTitle = "";
    let eventStartAt = 0;

    const result = await runNamedLocalTool(
      "calendar",
      { action: "add", title: "Vedans' birthday", date: "October 30th" },
      null,
      {
        now: () => now,
        setCalendarEvent: async ({ title, startAt, allDay }) => {
          eventTitle = title;
          eventStartAt = startAt;
          return { calendarOpened: true, eventCreated: allDay === true, detail: "Added it to Calendar." };
        }
      }
    );

    const date = new Date(eventStartAt);
    expect(eventTitle).toBe("Vedans' birthday");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(9);
    expect(date.getDate()).toBe(30);
    expect(result.text).toContain("Opened Calendar");
    expect(result.text).toContain("Added Vedans' birthday to Calendar");
  });

  it("adds weekday items to the next matching Calendar date", async () => {
    const now = Date.parse("2026-07-04T16:22:00-05:00");
    let eventStartAt = 0;

    await runNamedLocalTool("calendar", { action: "add", title: "Vidanci's birthday", date: "Wednesday" }, null, {
      now: () => now,
      setCalendarEvent: async ({ startAt }) => {
        eventStartAt = startAt;
        return { calendarOpened: true, eventCreated: true, detail: "Added it to Calendar." };
      }
    });

    const date = new Date(eventStartAt);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(6);
    expect(date.getDate()).toBe(8);
  });

  it("lists morning Calendar events", async () => {
    const now = Date.parse("2026-07-04T16:22:00-05:00");
    let queriedStartAt = 0;
    let queriedEndAt = 0;

    const result = await runNamedLocalTool("calendar", { action: "list", date: "Wednesday", period: "morning" }, null, {
      now: () => now,
      listCalendarEvents: async ({ startAt, endAt }) => {
        queriedStartAt = startAt;
        queriedEndAt = endAt;
        return {
          calendarOpened: true,
          detail: "Read Calendar events.",
          events: [{ title: "Vidanci's birthday", startAt: Date.parse("2026-07-08T09:00:00-05:00"), allDay: false }]
        };
      }
    });

    const start = new Date(queriedStartAt);
    const end = new Date(queriedEndAt);
    expect(start.getDate()).toBe(8);
    expect(start.getHours()).toBe(5);
    expect(end.getHours()).toBe(12);
    expect(result.text).toContain("Vidanci's birthday");
    expect(result.text).toContain("9:00 AM");
  });

  it("adds alarm requests as timed Calendar events", async () => {
    let calendarTitle = "";
    let calendarStartAt = 0;

    const result = await runNamedLocalTool("alarm", { action: "set", time: "in 5 minutes", label: "test" }, null, {
      now: () => 1_000,
      setTimeout: () => {
        throw new Error("should not schedule a Pythos timer");
      },
      setCalendarEvent: async ({ title, startAt, allDay }) => {
        calendarTitle = title;
        calendarStartAt = startAt;
        return {
          calendarOpened: true,
          eventCreated: allDay === false,
          detail: "Added it to Calendar."
        };
      }
    });

    expect(calendarTitle).toBe("test");
    expect(calendarStartAt).toBe(301_000);
    expect(result.text).toContain("Opened Calendar");
    expect(result.text).toContain("Added test to Calendar");
    expect(result.text).not.toContain("Clock");
    expect(result.text).not.toContain("notification");
  });

  it("schedules tomorrow alarms from dotted a m phrases", async () => {
    const now = Date.parse("2026-07-04T16:22:00-05:00");
    let calendarStartAt = 0;

    await runNamedLocalTool("alarm", { action: "set", time: "5:00 am tomorrow", label: "Wake up" }, null, {
      now: () => now,
      setTimeout: () => {
        throw new Error("should not schedule a Pythos timer");
      },
      setCalendarEvent: async ({ startAt }) => {
        calendarStartAt = startAt;
        return { calendarOpened: true, eventCreated: true, detail: "Added it to Calendar." };
      }
    });

    const due = new Date(calendarStartAt);
    expect(due.getDate()).toBe(5);
    expect(due.getHours()).toBe(5);
    expect(due.getMinutes()).toBe(0);
  });

  it("schedules no-meridiem clock times for the next matching time", async () => {
    const now = Date.parse("2026-07-04T16:47:00-05:00");
    let calendarStartAt = 0;

    await runNamedLocalTool("alarm", { action: "set", time: "4:48", label: "Wake up" }, null, {
      now: () => now,
      setTimeout: () => {
        throw new Error("should not schedule a Pythos timer");
      },
      setCalendarEvent: async ({ startAt }) => {
        calendarStartAt = startAt;
        return { calendarOpened: true, eventCreated: true, detail: "Added it to Calendar." };
      }
    });

    const due = new Date(calendarStartAt);
    expect(due.getDate()).toBe(4);
    expect(due.getHours()).toBe(16);
    expect(due.getMinutes()).toBe(48);
  });

  it("rejects explicitly past today alarms instead of firing immediately", async () => {
    const now = Date.parse("2026-07-04T16:47:00-05:00");

    await expect(
      runNamedLocalTool("alarm", { action: "set", time: "5:00 am today", label: "Wake up" }, null, {
        now: () => now,
        setTimeout: () => {
          throw new Error("should not schedule");
        }
      })
    ).rejects.toThrow("already passed today");
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

describe("capabilities tool", () => {
  it("returns a spoken capability summary", async () => {
    const result = await runNamedLocalTool("capabilities", {}, null);
    expect(result.name).toBe("capabilities");
    expect(result.text.toLowerCase()).toContain("on-device");
    expect(result.text.toLowerCase()).toContain("open apps");
  });
});
