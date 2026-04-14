// worker.js — Cloudflare Worker streaming proxy.
// Accepts OpenAI-compatible requests, delegates generation to
// the Wix backend, and re-streams tokens as real SSE.

const WIX_BACKEND = "https://patrickring9.wixstudio.com/http/_functions";
const MODEL_ID    = "lm-ngram";

// ── HTTP helpers ────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ── Completion handler ──────────────────────────────────────────────

async function handleCompletion(request, ctx) {
  const body = await request.json();
  const wantStream = body.stream !== false;

  // Always ask Wix for a non-streaming response (includes _deltas).
  const wixPayload = { ...body, stream: false };

  const wixRes = await fetch(`${WIX_BACKEND}/v1ChatCompletions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wixPayload),
  });

  if (!wixRes.ok) {
    const errText = await wixRes.text();
    return new Response(errText, {
      status: wixRes.status,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const result = await wixRes.json();

  // ── Non-streaming pass-through ──────────────────────────────────
  if (!wantStream) {
    const { _deltas, ...clean } = result;
    return json(clean);
  }

  // ── Streaming (SSE) ─────────────────────────────────────────────
  const { readable, writable } = new TransformStream();
  const writer  = writable.getWriter();
  const encoder = new TextEncoder();
  const write   = (text) => writer.write(encoder.encode(text));

  const deltas       = result._deltas ?? [];
  const completionId = result.id;
  const created      = result.created;
  const finishReason = result.choices?.[0]?.finish_reason ?? "stop";
  const usage        = result.usage;

  const generatePromise = (async () => {
    try {
      // Role preamble chunk
      await write(sseEvent({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: MODEL_ID,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      }));

      // Stream each token delta with a small pause for perceived typing
      for (let i = 0; i < deltas.length; i++) {
        const content = deltas[i];
        if (content === "") continue;

        await write(sseEvent({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: MODEL_ID,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        }));

        // Tiny yield so the runtime flushes each event
        await new Promise((r) => setTimeout(r, 15));
      }

      // Final chunk with finish_reason + usage
      await write(sseEvent({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage,
      }));

      await write("data: [DONE]\n\n");
      await writer.close();
    } catch (err) {
      try {
        await write(sseEvent({
          error: { message: err?.message ?? String(err), type: "server_error" },
        }));
      } catch { /* writer closed */ }
      await writer.close().catch(() => {});
    }
  })();

  ctx.waitUntil(generatePromise);

  return new Response(readable, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      Connection:      "keep-alive",
      ...CORS,
    },
  });
}

// ── Router ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/v1/models" && request.method === "GET") {
      return json({
        object: "list",
        data: [{ id: MODEL_ID, object: "model", created: 1700000000, owned_by: "local" }],
      });
    }

    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      return handleCompletion(request, ctx);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ status: "ok", model: MODEL_ID, backend: "wix-proxy" });
    }

    return json({ error: { message: "Not found", type: "invalid_request_error" } }, 404);
  },
};
