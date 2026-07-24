import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { submitVideoJob, pollVideoJob } from "../../src/images/xai-video-client";

const PREV_HOME = process.env.OPENCODEX_HOME;
beforeAll(() => { process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-test-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; });

const AUTH = { baseUrl: "https://api.x.ai", token: "xai-test-key" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Replace globalThis.fetch with a stub that captures the request and returns a canned response. */
function stubFetch(status: number, body: unknown): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("submitVideoJob", () => {
  test("POST /videos/generations with correct body (model, prompt, duration, resolution, aspect_ratio)", async () => {
    const calls = stubFetch(200, { request_id: "req-123" });
    await submitVideoJob(
      { prompt: "a flying car", model: "grok-imagine-video", duration: 10, resolution: "720p", aspectRatio: "16:9" },
      AUTH,
    );
    expect(calls[0]!.url).toContain("/videos/generations");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}");
    expect(body.model).toBe("grok-imagine-video");
    expect(body.prompt).toBe("a flying car");
    expect(body.duration).toBe(10);
    expect(body.resolution).toBe("720p");
    expect(body.aspect_ratio).toBe("16:9");
  });

  test("returns requestId from response", async () => {
    stubFetch(200, { request_id: "req-abc-456" });
    const result = await submitVideoJob({ prompt: "x" }, AUTH);
    expect(result.requestId).toBe("req-abc-456");
  });

  test("non-2xx → throws error with status", async () => {
    stubFetch(429, { error: "rate limited" });
    await expect(submitVideoJob({ prompt: "x" }, AUTH)).rejects.toThrow("429");
  });

  test("missing request_id in response → throws error", async () => {
    stubFetch(200, { foo: "bar" });
    await expect(submitVideoJob({ prompt: "x" }, AUTH)).rejects.toThrow("request_id");
  });
});

describe("pollVideoJob", () => {
  test("GET /videos/{requestId}", async () => {
    const calls = stubFetch(200, { status: "processing" });
    await pollVideoJob("req-123", AUTH);
    expect(calls[0]!.url).toContain("/videos/req-123");
    expect(calls[0]!.init?.method).toBe("GET");
  });

  test("status 'done' with video url → returns { status: 'done', videoUrl }", async () => {
    stubFetch(200, { status: "done", video: { url: "https://cdn.example.com/v.mp4" } });
    const result = await pollVideoJob("req-123", AUTH);
    expect(result.status).toBe("done");
    expect(result.videoUrl).toBe("https://cdn.example.com/v.mp4");
  });

  test("status 'processing' → returns { status: 'processing' }", async () => {
    stubFetch(200, { status: "processing" });
    const result = await pollVideoJob("req-123", AUTH);
    expect(result.status).toBe("processing");
    expect(result.videoUrl).toBeUndefined();
  });

  test("status 'failed' → returns { status: 'failed' }", async () => {
    stubFetch(200, { status: "failed" });
    const result = await pollVideoJob("req-123", AUTH);
    expect(result.status).toBe("failed");
  });

  test("normalizes alternative status strings ('completed' → 'done', 'error' → 'failed')", async () => {
    stubFetch(200, { status: "completed", video: { url: "https://cdn.example.com/v2.mp4" } });
    const doneResult = await pollVideoJob("req-123", AUTH);
    expect(doneResult.status).toBe("done");

    stubFetch(200, { status: "error" });
    const failedResult = await pollVideoJob("req-123", AUTH);
    expect(failedResult.status).toBe("failed");
  });
});
