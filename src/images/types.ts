import type { OcxProviderConfig } from "../types";

/** Shared plan shape for image and video bridges. */
export interface MediaBridgePlan {
  provider: OcxProviderConfig;
  auth: { baseUrl: string; token: string };
  model: string;
  toolNames: Set<string>;
}

/** Shared result shape for image and video fulfillment. */
export interface MediaCallResult {
  ok: boolean;
  model: string;
  prompt: string;
  path?: string;
  files: string[];
  count: number;
  markdown?: string;
  error?: string;
}

// Type aliases preserve existing import names.
export type ImageBridgePlan = MediaBridgePlan;
export type VideoBridgePlan = MediaBridgePlan;
export type ImageCallResult = MediaCallResult;
export type VideoCallResult = MediaCallResult;
