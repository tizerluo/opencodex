import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OcxConfig, OcxProviderConfig, OcxParsedRequest } from "../../src/types";

const PREV_HOME = process.env.OPENCODEX_HOME;
beforeAll(() => { process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-test-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; });

/** Mutable credential that the mocked getCredential returns. */
let credResult: { access: string } | null = null;
mock.module("../../src/oauth/store", () => ({
  getCredential: () => credResult,
}));

const { planVideoBridge } = await import("../../src/images/plan");

function makeConfig(
  providers: Record<string, Partial<OcxProviderConfig>>,
  images?: { videoBridgeEnabled?: boolean; videoBridgeModel?: string },
): OcxConfig {
  return {
    port: 0,
    defaultProvider: "test",
    providers: Object.fromEntries(
      Object.entries(providers).map(([k, v]) => [k, { adapter: "openai", baseUrl: "https://api.test.com", ...v }]),
    ),
    ...(images ? { images } : {}),
  } as OcxConfig;
}

function makeParsed(): OcxParsedRequest {
  return {
    modelId: "test-model",
    context: { messages: [], tools: [] },
    stream: true,
    options: {},
  } as OcxParsedRequest;
}

const routed = { adapter: "openai", baseUrl: "https://api.anthropic.com" } as OcxProviderConfig;
const openaiRouted = { adapter: "openai", baseUrl: "https://api.openai.com" } as OcxProviderConfig;

describe("planVideoBridge", () => {
  test("videoBridgeEnabled !== true → undefined (opt-in required)", () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { videoBridgeEnabled: false });
    expect(planVideoBridge(cfg, makeParsed(), routed)).toBeUndefined();
  });

  test("videoBridgeEnabled === true with non-OpenAI routed + xAI provider present → returns VideoBridgePlan", () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { videoBridgeEnabled: true });
    const plan = planVideoBridge(cfg, makeParsed(), routed);
    expect(plan).toBeDefined();
    expect(plan!.model).toBe("grok-imagine-video");
    expect(plan!.auth.token).toBe("test-token");
    expect(plan!.auth.baseUrl).toBe("https://api.x.ai");
  });

  test("routed provider is api.openai.com → undefined", () => {
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { videoBridgeEnabled: true });
    expect(planVideoBridge(cfg, makeParsed(), openaiRouted)).toBeUndefined();
  });

  test("no xAI provider → undefined", () => {
    const cfg = makeConfig({ test: routed }, { videoBridgeEnabled: true });
    expect(planVideoBridge(cfg, makeParsed(), routed)).toBeUndefined();
  });

  test("custom model via videoBridgeModel config", () => {
    const cfg = makeConfig(
      { xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } },
      { videoBridgeEnabled: true, videoBridgeModel: "custom-video-model" },
    );
    expect(planVideoBridge(cfg, makeParsed(), routed)!.model).toBe("custom-video-model");
  });

  test("xAI provider with OAuth (getCredential) → returns plan", () => {
    credResult = { access: "fake-oauth-123" };
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai" } }, { videoBridgeEnabled: true });
    const plan = planVideoBridge(cfg, makeParsed(), routed);
    expect(plan).toBeDefined();
    expect(plan!.auth.token).toBe("fake-oauth-123");
    credResult = null;
  });

  test("toolNames includes VIDEO_GEN_TOOL_NAME so the loop can intercept synthetic calls", async () => {
    const { VIDEO_GEN_TOOL_NAME } = await import("../../src/images/synthetic-tool");
    const cfg = makeConfig({ xai: { baseUrl: "https://api.x.ai", apiKey: "test-token" } }, { videoBridgeEnabled: true });
    const plan = planVideoBridge(cfg, makeParsed(), routed);
    expect(plan).toBeDefined();
    expect(plan!.toolNames.has(VIDEO_GEN_TOOL_NAME)).toBe(true);
  });
});
