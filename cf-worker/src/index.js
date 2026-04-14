// index.js — Cloudflare Worker entry point.
// Exposes an OpenAI-compatible /v1/chat/completions streaming endpoint
// backed by a local n-gram language model.

import { loadModels } from "./models.js";
import {
  getNextToken,
  tokensToText,
  computeContentDelta,
  countSentences,
  displayToken,
} from "./engine.js";

// ── Helpers ─────────────────────────────────────────────────────────

const MODEL_ID = "lm-ngram";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function tokenize(text) {
  return String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Turn the OpenAI `messages` array into a flat token context window.
 * We concatenate all message contents in order; system messages
 * act as seed context, user/assistant messages extend it.
 */
function messagesToContext(messages) {
  const tokens = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      tokens.push(...tokenize(msg.content));
    }
  }
  return tokens;
}

// ── SSE streaming completion ────────────────────────────────────────

async function streamCompletion(request, env) {
  const body = await request.json();
  const messages = body.messages ?? [];
  const maxTokens = Math.max(8, Number(body.max_tokens ?? body.max_completion_tokens ?? 256));
  const maxSentences = Math.max(1, Number(body.max_sentences ?? 8));
  const stream = body.stream !== false; // default to streaming

  const models = await loadModels(env.MODEL_BASE_URL);
  const context = messagesToContext(messages);

  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // ── Non-streaming path ──────────────────────────────────────────
  if (!stream) {
    const generated = [];
    const localContext = [...context];

    for (let i = 0; i < maxTokens; i++) {
      const token = getNextToken(localContext, models);
      if (!token) break;
      localContext.push(token);
      generated.push(token);

      const partial = tokensToText(generated).trim();
      if (countSentences(partial) >= maxSentences && /[.!?]$/.test(displayToken(token))) {
        break;
      }
    }

    const text = tokensToText(generated).trim();
    return json({
      id: completionId,
      object: "chat.completion",
      created,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: generated.length >= maxTokens ? "length" : "stop",
        },
      ],
      usage: {
        prompt_tokens: context.length,
        completion_tokens: generated.length,
        total_tokens: context.length + generated.length,
      },
    });
  }

  // ── Streaming (SSE) path ────────────────────────────────────────
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = (text) => writer.write(encoder.encode(text));

  const generate = async () => {
    // Role announcement chunk
    await write(
      sseEvent({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: MODEL_ID,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      }),
    );

    const generated = [];
    const localContext = [...context];
    let runningText = "";
    let finishReason = "stop";

    for (let i = 0; i < maxTokens; i++) {
      const token = getNextToken(localContext, models);
      if (!token) break;

      localContext.push(token);
      generated.push(token);

      const contentDelta = computeContentDelta(runningText, token);
      runningText += contentDelta;

      await write(
        sseEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: MODEL_ID,
          choices: [{ index: 0, delta: { content: contentDelta }, finish_reason: null }],
        }),
      );

      const partial = tokensToText(generated).trim();
      if (countSentences(partial) >= maxSentences && /[.!?]$/.test(displayToken(token))) {
        break;
      }

      if (i === maxTokens - 1) {
        finishReason = "length";
      }
    }

    // Final chunk with finish_reason and usage
    await write(
      sseEvent({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: {
          prompt_tokens: context.length,
          completion_tokens: generated.length,
          total_tokens: context.length + generated.length,
        },
      }),
    );

    await write("data: [DONE]\n\n");
    await writer.close();
  };

  // Fire-and-forget into the stream; CF will keep the connection alive
  // via waitUntil.
  const generatePromise = generate().catch(async (err) => {
    try {
      await write(
        sseEvent({
          error: { message: err?.message ?? String(err), type: "server_error" },
        }),
      );
    } catch {
      // writer may already be closed
    }
    await writer.close().catch(() => {});
  });

  // Use waitUntil so the runtime doesn't kill the stream early.
  if (request.ctx?.waitUntil) {
    request.ctx.waitUntil(generatePromise);
  }

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

// ── Router ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // /v1/models — list available models (OpenAI compat)
    if (url.pathname === "/v1/models" && request.method === "GET") {
      return json({
        object: "list",
        data: [
          {
            id: MODEL_ID,
            object: "model",
            created: 1700000000,
            owned_by: "local",
          },
        ],
      });
    }

    // /v1/chat/completions — the main endpoint
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      // Attach ctx so the streaming handler can call waitUntil.
      request.ctx = ctx;
      return streamCompletion(request, env);
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ status: "ok", model: MODEL_ID });
    }

    return json({ error: { message: "Not found", type: "invalid_request_error" } }, 404);
  },
};
