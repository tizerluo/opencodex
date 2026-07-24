import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import type { ImageBridgePlan, VideoBridgePlan } from "./types";
import { getCredential } from "../oauth/store";
import { resolveEnvValue } from "../config";
import { IMAGE_GEN_TOOL_NAME, VIDEO_GEN_TOOL_NAME } from "./synthetic-tool";

const DEFAULT_MODEL = "grok-imagine-image-quality";

const DEFAULT_VIDEO_MODEL = "grok-imagine-video";

export function findXaiProvider(config: OcxConfig): OcxProviderConfig | undefined {
  // Primary: well-known name "xai"
  const xai = config.providers["xai"];
  if (xai && xai.disabled !== true) return xai;
  // Fallback: hostname match for custom-named xAI configs
  for (const p of Object.values(config.providers)) {
    if (p.disabled) continue;
    try {
      const host = new URL(p.baseUrl).hostname;
      if (host === "api.x.ai" || host === "cli-chat-proxy.grok.com") return p;
    } catch { /* invalid baseUrl */ }
  }
  return undefined;
}

export function resolveXaiToken(provider: OcxProviderConfig): string | undefined {
  const apiKey = resolveEnvValue(provider.apiKey)?.trim();
  if (apiKey) return apiKey;
  const cred = getCredential("xai");
  return cred?.access ?? undefined;
}

export function planImageBridge(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  routedProvider: OcxProviderConfig,
): ImageBridgePlan | undefined {
  if (config.images?.bridgeEnabled === false) return undefined;
  if (!parsed._imageGeneration) return undefined;
  // Don't intercept for OpenAI native passthrough
  const host = (() => { try { return new URL(routedProvider.baseUrl).hostname; } catch { return ""; } })();
  if (host === "api.openai.com") return undefined;
  const xai = findXaiProvider(config);
  if (!xai) return undefined;
  const token = resolveXaiToken(xai);
  if (!token) return undefined;
  // The synthetic tool injected into the conversation is named IMAGE_GEN_TOOL_NAME,
  // which is what the model will actually call. Merge it with any original hosted tool names.
  const toolNames = new Set(parsed._imageGeneration.toolNames);
  toolNames.add(IMAGE_GEN_TOOL_NAME);
  return {
    provider: xai,
    auth: { baseUrl: xai.baseUrl.replace(/\/+$/, ""), token },
    model: config.images?.bridgeModel ?? DEFAULT_MODEL,
    toolNames,
  };
}

/**
 * Decide whether the video bridge should activate for this request. Unlike images, video
 * generation has no hosted OpenAI tool type — the synthetic `video_gen` tool is unconditionally
 * injected when `videoBridgeEnabled` is true. The bridge activates only when:
 *   1. videoBridgeEnabled is explicitly true (opt-in)
 *   2. the routed provider is NOT api.openai.com (native passthrough)
 *   3. an xAI provider with a valid token is available
 */
export function planVideoBridge(
  config: OcxConfig,
  _parsed: OcxParsedRequest,
  routedProvider: OcxProviderConfig,
): VideoBridgePlan | undefined {
  if (config.images?.videoBridgeEnabled !== true) return undefined;
  // Don't intercept for OpenAI native passthrough
  const host = (() => { try { return new URL(routedProvider.baseUrl).hostname; } catch { return ""; } })();
  if (host === "api.openai.com") return undefined;
  const xai = findXaiProvider(config);
  if (!xai) return undefined;
  const token = resolveXaiToken(xai);
  if (!token) return undefined;
  const toolNames = new Set<string>();
  toolNames.add(VIDEO_GEN_TOOL_NAME);
  return {
    provider: xai,
    auth: { baseUrl: xai.baseUrl.replace(/\/+$/, ""), token },
    model: config.images?.videoBridgeModel ?? DEFAULT_VIDEO_MODEL,
    toolNames,
  };
}
