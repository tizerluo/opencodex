import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { XaiVideoPollResult } from "../../src/images/xai-video-client";

const PREV_HOME = process.env.OPENCODEX_HOME;
beforeAll(() => { process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-test-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; });

// --- Mutable mock state (reset() restores defaults before each test) ---
let pollQueue: XaiVideoPollResult[] = [];
let pollFallback: XaiVideoPollResult = { status: "processing" };

mock.module("../../src/images/xai-video-client", () => ({
  submitVideoJob: async () => ({ requestId: "test-req" }),
  pollVideoJob: async () => (pollQueue.length > 0 ? pollQueue.shift()! : pollFallback),
}));

const { parseVideoCallArgs, pollVideoWithHeartbeats, buildVideoResult } = await import("../../src/images/fulfill-video");

const AUTH = { baseUrl: "https://api.x.ai", token: "xai-test-key" };

function reset(): void {
  pollQueue = [];
  pollFallback = { status: "processing" };
}

// --- Time-control stubs so the internal sleep() doesn't block tests ---
const realDateNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
let mockClock = 0;

function installFastTime(): void {
  mockClock = 0;
  Date.now = (() => mockClock) as typeof Date.now;
  globalThis.setTimeout = (((fn: Function, ms?: number) => {
    mockClock += ms ?? 0;
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
}

function restoreTime(): void {
  Date.now = realDateNow;
  globalThis.setTimeout = realSetTimeout;
}

/** Fully drain an async generator, collecting yielded heartbeats and the return value. */
async function drain<T, R>(gen: AsyncGenerator<T, R>): Promise<{ heartbeats: T[]; result: R }> {
  const heartbeats: T[] = [];
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { heartbeats, result: value as R };
    heartbeats.push(value);
  }
}

// ---------------------------------------------------------------------------
describe("parseVideoCallArgs", () => {
  test("valid args with all fields → ok:true with correct values", () => {
    const r = parseVideoCallArgs(JSON.stringify({ prompt: "a cat", duration: 5, resolution: "720p", aspect_ratio: "16:9" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prompt).toBe("a cat");
      expect(r.duration).toBe(5);
      expect(r.resolution).toBe("720p");
      expect(r.aspectRatio).toBe("16:9");
    }
  });

  test("missing prompt → ok:false 'missing prompt'", () => {
    const r = parseVideoCallArgs(JSON.stringify({ duration: 5 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing prompt");
  });

  test("invalid JSON → ok:false 'invalid arguments JSON'", () => {
    const r = parseVideoCallArgs("{bad json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid arguments JSON");
  });

  test("null input → ok:false 'invalid arguments JSON'", () => {
    const r = parseVideoCallArgs("null");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid arguments JSON");
  });

  test("duration clamped to 1-15", () => {
    const tooHigh = parseVideoCallArgs(JSON.stringify({ prompt: "x", duration: 100 }));
    expect(tooHigh.ok).toBe(true);
    if (tooHigh.ok) expect(tooHigh.duration).toBe(15);

    const tooLow = parseVideoCallArgs(JSON.stringify({ prompt: "x", duration: 0 }));
    expect(tooLow.ok).toBe(true);
    if (tooLow.ok) expect(tooLow.duration).toBe(1);
  });

  test("input key as alternative for prompt", () => {
    const r = parseVideoCallArgs(JSON.stringify({ input: "a dog running" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prompt).toBe("a dog running");
  });

  test("aspect_ratio passed through", () => {
    const r = parseVideoCallArgs(JSON.stringify({ prompt: "x", aspect_ratio: "9:16" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aspectRatio).toBe("9:16");
  });
});

// ---------------------------------------------------------------------------
describe("pollVideoWithHeartbeats", () => {
  test("done on first poll → yields heartbeat, returns { ok: true, videoUrl }", async () => {
    reset();
    pollQueue = [{ status: "done", videoUrl: "https://cdn.example.com/v.mp4" }];
    installFastTime();
    try {
      const { heartbeats, result } = await drain(
        pollVideoWithHeartbeats("req-1", AUTH, new AbortController().signal, 300_000),
      );
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
      expect(heartbeats[0]!.type).toBe("heartbeat");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.videoUrl).toBe("https://cdn.example.com/v.mp4");
    } finally {
      restoreTime();
    }
  });

  test("processing then done → yields at least 2 heartbeats, returns ok:true", async () => {
    reset();
    pollQueue = [
      { status: "processing" },
      { status: "done", videoUrl: "https://cdn.example.com/v2.mp4" },
    ];
    installFastTime();
    try {
      const { heartbeats, result } = await drain(
        pollVideoWithHeartbeats("req-2", AUTH, new AbortController().signal, 300_000),
      );
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.videoUrl).toBe("https://cdn.example.com/v2.mp4");
    } finally {
      restoreTime();
    }
  });

  test("failed → returns { ok: false, error }", async () => {
    reset();
    pollQueue = [{ status: "failed" }];
    installFastTime();
    try {
      const { result } = await drain(
        pollVideoWithHeartbeats("req-3", AUTH, new AbortController().signal, 300_000),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("failed");
    } finally {
      restoreTime();
    }
  });

  test("timeout (timeoutMs very low) → returns { ok: false, 'timed out' }", async () => {
    reset();
    pollQueue = [];
    pollFallback = { status: "processing" };
    installFastTime();
    try {
      const { result } = await drain(
        pollVideoWithHeartbeats("req-4", AUTH, new AbortController().signal, 0),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("timed out");
    } finally {
      restoreTime();
    }
  });
});

// ---------------------------------------------------------------------------
describe("buildVideoResult", () => {
  test("returns correct VideoCallResult with markdown [video](path)", () => {
    const result = buildVideoResult("/test/video.mp4", "a flying car", "grok-imagine-video");
    expect(result.ok).toBe(true);
    expect(result.model).toBe("grok-imagine-video");
    expect(result.prompt).toBe("a flying car");
    expect(result.path).toBe("/test/video.mp4");
    expect(result.files).toEqual(["/test/video.mp4"]);
    expect(result.count).toBe(1);
    expect(result.markdown).toBe("[video](/test/video.mp4)");
  });
});
