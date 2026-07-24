---
title: Video Bridge
description: Generate videos via xAI Grok Imagine Video when using a non-OpenAI provider.
---

## Overview

The Video Bridge lets your routed (non-OpenAI) model generate short videos through xAI Grok
Imagine Video. Since there is no OpenAI-hosted video generation tool, OpenCodex injects a
synthetic `video_gen` function tool that the model can call like any other. When the model
invokes it, the bridge submits a generation job to xAI, polls until completion, downloads the
result, and feeds the local file path back into the conversation.

## Prerequisites

- An xAI account with Grok Imagine Video access.
- Either `ocx login xai` (OAuth) or an xAI API key configured in settings.
- A non-OpenAI model selected as your active provider.

## Configuration

Video Bridge options live under `images` in `~/.opencodex/config.json`:

```json
{
  "images": {
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `videoBridgeEnabled` | `false` | Master switch. Must be explicitly set to `true` to enable. |
| `videoBridgeModel` | `grok-imagine-video` | The xAI video model id. |
| `videoMaxRounds` | `2` | Max video-generation loop iterations per turn. |
| `videoTimeoutMs` | `300000` | Per-video timeout in ms (5 minutes). Generation can take 30s–5min. |

## How It Works

1. When `videoBridgeEnabled` is `true`, OpenCodex injects a synthetic `video_gen` function tool
   into the model's toolset.
2. The model decides when to call it based on the user's request (e.g., "generate a video of…").
3. When the model calls `video_gen`, OpenCodex intercepts the call and submits a generation job
   to xAI's `/v1/videos/generations` endpoint.
4. The bridge polls the job status every few seconds, sending heartbeat progress messages to
   keep the SSE stream alive (e.g., "Generating video... 45s").
5. When the video is ready, it's downloaded to `~/.opencodex/artifacts/` and the local file
   path is returned to the model as the tool result.
6. The model reports the file location to the user.

## Supported Parameters

The `video_gen` tool accepts:

| Parameter | Type | Range | Default |
| --- | --- | --- | --- |
| `prompt` | string | required | — |
| `duration` | integer | 1–15 seconds | 6 |
| `resolution` | string | `480p` or `720p` | `720p` |
| `aspect_ratio` | string | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3` | `16:9` |

## Limitations

- **Only xAI Grok Imagine Video is supported.** Other video providers may be added later.
- **Video generation is slow.** A typical 6-second video takes 30–120 seconds to generate.
- **Costs apply.** Video generation via xAI requires credits. Expect ~$0.05/sec at 480p,
  ~$0.07/sec at 720p.
- **One video per call.** Unlike images, the `n` parameter is not supported for video.
- **Coexists with Image Bridge.** Both can be enabled simultaneously. When both are active, the
  model sees both `image_gen` and `video_gen` tools.
