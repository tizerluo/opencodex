/**
 * Media bridge agentic loop — supports both image and video generation sidecars.
 *
 * The routed (non-OpenAI) model runs in a bounded loop. Each iteration is streamed and fully
 * buffered internally. If the model calls a media-generation tool (image_gen or video_gen), the
 * bridge fulfills it via the xAI sidecar, injects the result as a tool_result, and loops (bounded
 * by maxRounds). When the model produces a real tool call or the budget is exhausted, the
 * passthrough events are replayed to the bridge for final SSE output.
 */
import type { ProviderAdapter } from "../adapters/base";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxThinkingContent } from "../types";
import { namespacedToolName } from "../types";
import { bridgeToResponsesSSE } from "../bridge";
import { clearableDeadline } from "../lib/abort";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import { parseStreamWithProgress, RoutedModelInactivityError, WebSearchStreamProtocolError } from "../web-search/progress-stream";
import { fulfillImageCall } from "./fulfill";
import { parseVideoCallArgs, pollVideoWithHeartbeats, buildVideoResult, createVideoBudget } from "./fulfill-video";
import { submitVideoJob } from "./xai-video-client";
import { downloadVideoToArtifact, createImageBudget } from "./artifacts";
import type { ImageBridgePlan, VideoBridgePlan, VideoCallResult } from "./types";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};

const CONNECT_TIMEOUT_MS = 200_000;
const STALL_TIMEOUT_MS = 200_000;
const DEFAULT_MAX_ROUNDS = 3;

interface ImageCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Split an iteration's adapter events into (a) the media-generation tool calls to intercept and
 * (b) the events to pass through to Codex. A media tool-call's own start/delta/end events are
 * dropped (Codex never sees the synthetic tool); every other event — text, thinking, real tool
 * calls, done — is preserved in order.
 */
function scanEventsForImageCall(events: AdapterEvent[], toolNames: Set<string>): {
  calls: ImageCall[];
  passthrough: AdapterEvent[];
  hasRealToolCall: boolean;
} {
  const calls: ImageCall[] = [];
  const passthrough: AdapterEvent[] = [];
  let hasRealToolCall = false;
  let pending: { name: string; id: string; argsBuf: string; events: AdapterEvent[] } | null = null;
  const flushPending = (): void => {
    if (pending && !toolNames.has(pending.name)) {
      passthrough.push(...pending.events);
      hasRealToolCall = true;
    }
    pending = null;
  };
  for (const e of events) {
    if (e.type === "tool_call_start") {
      flushPending();
      pending = { name: e.name, id: e.id, argsBuf: "", events: [e] };
    } else if (e.type === "tool_call_delta" && pending) {
      pending.argsBuf += e.arguments;
      pending.events.push(e);
    } else if (e.type === "tool_call_end" && pending) {
      pending.events.push(e);
      if (toolNames.has(pending.name)) {
        calls.push({ id: pending.id, name: pending.name, args: pending.argsBuf });
      } else {
        passthrough.push(...pending.events);
        hasRealToolCall = true;
      }
      pending = null;
    } else {
      passthrough.push(e);
    }
  }
  flushPending();
  return { calls, passthrough, hasRealToolCall };
}

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const e of events) yield e;
}

/**
 * Collect the thinking block that preceded an image tool call, so the replayed assistant turn can
 * carry it. Anthropic extended thinking REQUIRES the assistant message containing tool_use to start
 * with its signed thinking blocks.
 */
function extractIterationThinking(events: AdapterEvent[]): OcxThinkingContent | null {
  let thinking = "";
  let signature: string | undefined;
  const redacted: string[] = [];
  for (const e of events) {
    if (e.type === "thinking_delta") thinking += e.thinking;
    else if (e.type === "thinking_signature") signature = e.signature;
    else if (e.type === "redacted_thinking") redacted.push(e.data);
  }
  if (!thinking && !signature && redacted.length === 0) return null;
  return {
    type: "thinking",
    thinking,
    ...(signature ? { signature } : {}),
    ...(redacted.length > 0 ? { redacted } : {}),
  };
}

/**
 * Inject an assistant toolCall + toolResult message pair into the conversation history.
 * Shared by both image and video fulfillment paths.
 */
function injectToolResult(
  messages: OcxMessage[],
  call: ImageCall,
  callIndex: number,
  iterationThinking: OcxThinkingContent | null,
  result: { ok: boolean },
): void {
  const now = Date.now();
  let parsedArgs: Record<string, unknown> = {};
  try { parsedArgs = JSON.parse(call.args || "{}"); } catch { /* malformed args */ }
  messages.push({
    role: "assistant",
    content: [
      ...(callIndex === 0 && iterationThinking ? [iterationThinking] : []),
      { type: "toolCall" as const, id: call.id, name: call.name, arguments: parsedArgs },
    ],
    timestamp: now,
  });
  messages.push({
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: JSON.stringify(result),
    isError: !result.ok,
    timestamp: now,
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error", code: null } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Hard provider/parse failure inside an iteration. The eager first iteration converts it to a
 *  non-2xx jsonError; later (already-streaming) iterations surface it as an in-stream error event. */
class LoopError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LoopError";
  }
}

export interface ImageBridgeDeps {
  parsed: OcxParsedRequest;
  adapter: ProviderAdapter;
  /** Image bridge plan. At least one of `plan` or `videoPlan` must be provided. */
  plan?: ImageBridgePlan;
  /** Video bridge plan. At least one of `plan` or `videoPlan` must be provided. */
  videoPlan?: VideoBridgePlan;
  abortSignal?: AbortSignal;
  onFirstOutput?: () => void;
  /** Max generation rounds before forcing a final answer. Defaults to 3. */
  maxRounds?: number;
  /** Per-video generation timeout (ms) including polling. Defaults to 300000 (5 min). */
  videoTimeoutMs?: number;
}

/**
 * Run the main (non-OpenAI) model in a small agentic loop. Each upstream iteration is streamed and
 * fully buffered internally so raw byte progress is observable without leaking the synthetic tool or
 * preliminary assistant output. If the model invokes image or video generation, run it via the xAI
 * sidecar, inject the answer as a tool_result, and loop (bounded by `maxRounds`).
 */
export async function runWithImageBridge(deps: ImageBridgeDeps): Promise<Response> {
  const { parsed, adapter, plan, videoPlan, abortSignal } = deps;
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const videoTimeoutMs = deps.videoTimeoutMs ?? 300_000;
  const HARD_CAP = maxRounds + 1;

  // Merge tool names from both plans so the scanner can intercept image_gen and video_gen calls.
  const mediaToolNames = new Set<string>();
  if (plan) for (const n of plan.toolNames) mediaToolNames.add(n);
  if (videoPlan) for (const n of videoPlan.toolNames) mediaToolNames.add(n);

  const messages: OcxMessage[] = [...parsed.context.messages];
  const allTools = parsed.context.tools ?? [];
  // For the forced-final pass we drop media tools so the model MUST answer from the results already
  // in `messages` (can't generate again) — this guarantees a non-empty final answer.
  const toolsNoMedia = allTools.filter(t => !t.imageGeneration && !t.videoGeneration);
  const budget = createImageBudget();
  const vBudget = createVideoBudget();

  // Link an internal AbortController to the turn signal so a client cancel of the SSE body aborts
  // in-flight model fetches AND the sidecar.
  const internalAbort = new AbortController();
  const linkAbort = (): void => internalAbort.abort(abortSignal?.reason);
  if (abortSignal) {
    if (abortSignal.aborted) linkAbort();
    else abortSignal.addEventListener("abort", linkAbort, { once: true });
  }
  const signal = internalAbort.signal;

  interface IterationResponse {
    response: Response;
    responseAdapter: ProviderAdapter;
  }
  type IterationSplit = ReturnType<typeof scanEventsForImageCall>;

  // Acquire one iteration's final response headers. The first call is drained eagerly so an initial
  // connect/header/HTTP failure stays a non-2xx JSON response.
  const prepareIterationEvents = async function* (forceFinal: boolean): AsyncGenerator<AdapterEvent, IterationResponse> {
    const iterParsed: OcxParsedRequest = {
      ...parsed, stream: true,
      context: { ...parsed.context, messages, tools: forceFinal ? toolsNoMedia : allTools },
    };
    const headerDeadline = clearableDeadline(CONNECT_TIMEOUT_MS, signal);
    try {
      const request = await adapter.buildRequest(iterParsed, {
        headers: new Headers(),
        abortSignal: headerDeadline.signal,
      });
      const response = adapter.fetchResponse
        ? await adapter.fetchResponse(request, {
            abortSignal: headerDeadline.signal,
            timeoutMs: CONNECT_TIMEOUT_MS,
            returnRawErrors: true,
            stream: true,
          })
        : await fetchWithResetRetry(
            () => {
              const h = new Headers(request.headers);
              if (!h.has("accept-encoding")) h.set("accept-encoding", "identity");
              return fetch(request.url, {
                method: request.method,
                headers: h,
                body: request.body,
                signal: headerDeadline.signal,
              });
            },
            { abortSignal: headerDeadline.signal, label: "image-bridge-loop" },
          );

      // Final headers have arrived. Clear only the deadline timer before ANY body read.
      headerDeadline.clear();
      if (!response.ok) {
        let body: Awaited<ReturnType<typeof readBoundedResponseBody>>;
        try {
          body = await readBoundedResponseBody(response, { signal });
        } catch {
          if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
          throw new LoopError(response.status, `Provider error ${response.status}`);
        }
        let formatted = "";
        if (body.displaySafe && !body.truncated && body.text.trim() && adapter.formatErrorBody) {
          try {
            formatted = adapter.formatErrorBody(response.status, response.headers, body.text).trim();
          } catch { /* formatter hooks are best-effort */ }
        }
        const suffix = formatted ? `: ${formatted.slice(0, 400)}` : "";
        throw new LoopError(response.status, `Provider error ${response.status}${suffix}`);
      }
      return { response, responseAdapter: adapter };
    } catch (error) {
      if (headerDeadline.didExpire()) {
        throw new LoopError(504, `Provider response-header timeout after ${CONNECT_TIMEOUT_MS}ms during image-bridge`);
      }
      if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
      if (error instanceof LoopError) throw error;
      throw new LoopError(502, `Provider unreachable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      headerDeadline.clear();
    }
  };

  const prepareIterationDrained = async (forceFinal: boolean): Promise<IterationResponse> => {
    const it = prepareIterationEvents(forceFinal);
    let r = await it.next();
    while (!r.done) r = await it.next();
    return r.value;
  };

  // Consume and validate one successful response body. Only invisible heartbeat events escape while
  // semantic output remains buffered for safe scanning.
  const consumeIterationEvents = async function* (prepared: IterationResponse): AsyncGenerator<AdapterEvent, IterationSplit> {
    const events: AdapterEvent[] = [];
    try {
      const parse = prepared.responseAdapter.parseStream.bind(prepared.responseAdapter);
      for await (const event of parseStreamWithProgress(prepared.response, parse, {
        signal,
        inactivityTimeoutMs: STALL_TIMEOUT_MS,
      })) {
        if (event.type === "heartbeat") yield event;
        else events.push(event);
      }
    } catch (error) {
      if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
      if (error instanceof RoutedModelInactivityError) throw new LoopError(504, error.message);
      if (error instanceof WebSearchStreamProtocolError) throw new LoopError(502, error.message);
      throw new LoopError(502, `Provider stream error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const terminalIndexes = events.flatMap((event, index) =>
      event.type === "done" || event.type === "incomplete" || event.type === "error" ? [index] : []);
    if (terminalIndexes.length !== 1 || terminalIndexes[0] !== events.length - 1) {
      throw new LoopError(502, `Image-bridge adapter stream protocol error: expected one final terminal event, received ${terminalIndexes.length}`);
    }
    const terminal = events[terminalIndexes[0]!];
    if (terminal.type === "error") throw new LoopError(502, terminal.message);
    return scanEventsForImageCall(events, mediaToolNames);
  };

  // Eagerly acquire only the FIRST iteration's final headers so connect/header/HTTP failures remain
  // non-2xx JSON.
  let firstPrepared: IterationResponse;
  try {
    firstPrepared = await prepareIterationDrained(false);
  } catch (e) {
    if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
    if (e instanceof LoopError) return jsonError(e.status, e.message);
    throw e;
  }

  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeform = new Set<string>();
  const toolSearch = new Set<string>();
  for (const t of parsed.context.tools ?? []) {
    if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
    if (t.freeform) freeform.add(t.name);
    if (t.toolSearch) toolSearch.add(t.name);
  }

  // Drive the remaining iterations live. Image generation runs interleaved with the real sidecar
  // timing; the final answer's passthrough events come last.
  async function* produce(): AsyncGenerator<AdapterEvent> {
    let prepared = firstPrepared;
    try {
      for (let i = 0; i < HARD_CAP; i++) {
        const forceFinal = i >= maxRounds;
        try {
          // First loop turn reuses the eager HEADERS. Subsequent header acquisitions run here.
          if (i > 0) {
            yield { type: "heartbeat" };
            prepared = yield* prepareIterationEvents(forceFinal);
          }
          // Raw-byte progress heartbeats reach the bridge; semantic events remain buffered.
          const split = yield* consumeIterationEvents(prepared);

          // Loop (fulfill + re-ask) ONLY when the model's actionable output is purely image_gen. A
          // real tool call means this turn is terminal for Codex — finalize so those calls reach
          // Codex. forceFinal also finalizes.
          const shouldLoop = split.calls.length > 0 && !split.hasRealToolCall && !forceFinal;
          if (!shouldLoop) {
            yield* replay(split.passthrough);
            return;
          }

          // Fulfill each media call, then inject assistant + toolResult into messages.
          const iterationThinking = extractIterationThinking(split.passthrough);
          for (const [callIndex, call] of split.calls.entries()) {
            const isVideoCall = videoPlan?.toolNames.has(call.name) === true;

            if (isVideoCall) {
              // === Video path: submit → poll with heartbeats → download ===
              yield { type: "heartbeat" };
              const vArgs = parseVideoCallArgs(call.args);
              let vResult: VideoCallResult;
              if (!vArgs.ok) {
                vResult = { ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0, error: vArgs.error };
              } else {
                try {
                  const { requestId } = await submitVideoJob(
                    {
                      prompt: vArgs.prompt, model: videoPlan!.model,
                      ...(vArgs.duration != null ? { duration: vArgs.duration } : {}),
                      ...(vArgs.resolution != null ? { resolution: vArgs.resolution } : {}),
                      ...(vArgs.aspectRatio != null ? { aspectRatio: vArgs.aspectRatio } : {}),
                    },
                    videoPlan!.auth, signal,
                  );
                  // Consume the polling generator, forwarding heartbeats to the SSE stream.
                  const pollGen = pollVideoWithHeartbeats(requestId, videoPlan!.auth, signal, videoTimeoutMs);
                  let pollResult: { ok: true; videoUrl: string } | { ok: false; error: string };
                  try {
                    for (;;) {
                      const { value, done } = await pollGen.next();
                      if (done) { pollResult = value; break; }
                      yield value; // forward heartbeat to SSE
                    }
                  } finally {
                    // Ensure the generator is cleaned up if the loop exits early (e.g. abort).
                    await pollGen.return({ ok: false, error: "cancelled" }).catch(() => {});
                  }
                  if (signal.aborted) throw new LoopError(499, "client closed request during video-bridge");
                  if (pollResult.ok) {
                    const path = await downloadVideoToArtifact(pollResult.videoUrl, vBudget, signal);
                    vResult = buildVideoResult(path, vArgs.prompt, videoPlan!.model);
                  } else {
                    vResult = { ok: false, model: videoPlan!.model, prompt: vArgs.prompt, files: [], count: 0, error: pollResult.error };
                  }
                } catch (e) {
                  if (signal.aborted) throw new LoopError(499, "client closed request during video-bridge");
                  const error = e instanceof Error ? e.message : String(e);
                  vResult = { ok: false, model: videoPlan!.model, prompt: vArgs.prompt ?? "", files: [], count: 0, error };
                }
              }
              if (signal.aborted) throw new LoopError(499, "client closed request during video-bridge");
              injectToolResult(messages, call, callIndex, iterationThinking, vResult);
            } else {
              // === Image path ===
              if (!plan) throw new LoopError(500, "internal error: image plan missing for non-video tool call");
              yield { type: "heartbeat" };
              const result = await fulfillImageCall(
                { id: call.id, name: call.name, arguments: call.args },
                plan, budget, signal,
              );
              if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
              injectToolResult(messages, call, callIndex, iterationThinking, result);
            }
          }
        } catch (e) {
          yield { type: "error", message: e instanceof LoopError ? e.message : (e instanceof Error ? e.message : String(e)) };
          return;
        }
      }
    } finally {
      if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
    }
  }

  const sse = bridgeToResponsesSSE(
    produce(), parsed.modelId, toolNsMap, freeform, toolSearch, () => {
      internalAbort.abort("client closed responses stream");
    }, undefined,
    {
      responseId: "",
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      ...(deps.onFirstOutput ? { onFirstOutput: deps.onFirstOutput } : {}),
    },
  );
  return new Response(sse, { headers: SSE_HEADERS });
}
