/*******************
 http-functions.js
********************

'http-functions.js' is a reserved backend file that lets you expose APIs that respond to fetch 
requests from external services.

Use this file to create functions that expose the functionality of your site as a service. 
This functionality can be accessed by writing code that calls this site's APIs as defined by the 
functions you create here.

To learn more about using HTTP functions, including the endpoints for accessing the APIs, see:
https://wix.to/0lZ9qs8

*********
 Example
*********

The following HTTP function example returns the product of 2 operands.

To call this API, assuming this HTTP function is located in a premium site that is published 
and has the domain "mysite.com", you would use this URL:

https://mysite.com/_functions/multiply?leftOperand=3&rightOperand=4

Note: To access the APIs for your site, use one of the endpoint structures documented here:
https://wix.to/rZ5Dh89

***/

import { ok, serverError, response } from "wix-http-functions";
import { fetch as wixFetch } from "wix-fetch";
import wixRealtimeBackend from "wix-realtime-backend";

// http-functions.js — Wix Velo HTTP Functions
// OpenAI-compatible chat completions backed by n-gram language models.
//
// Deploy: place this file at backend/http-functions.js in your Wix site.
//
// Endpoints (Wix routes via /_functions/<name>):
//   POST /_functions/v1ChatCompletions  →  /v1/chat/completions equivalent
//   GET  /_functions/v1Models           →  /v1/models equivalent
//   GET  /_functions/health             →  health check
//
// Wix doesn't support true SSE streaming, so when stream:true the
// response body contains the full set of SSE chunks as text/event-stream
// (protocol-compatible — clients parsing SSE lines will work fine,
// they just receive them all at once instead of incrementally).

const MODEL_BASE_URL = "https://patrick-ring-motive.github.io/lm";
const MODEL_ID = "lm-ngram";

// ── Token formatting ────────────────────────────────────────────────

function safeNormalizeToken(token) {
    try {
        return JSON.parse(token);
    } catch {
        return String(token ?? "");
    }
}

function displayToken(token) {
    return String(safeNormalizeToken(token)).replace(/_/g, " ").trim();
}

function appendTokenToText(text, token) {
    const value = displayToken(token);
    if (!value) return text;
    if (!text) return value.charAt(0).toUpperCase() + value.slice(1);
    if (/^[,.;:!?%\]]/.test(value) || /^['\u2019]/.test(value)) {
        return `${text.trimEnd()}${value}`;
    }
    return `${text} ${value}`;
}

function tokensToText(tokens) {
    return tokens.reduce((text, token) => appendTokenToText(text, token), "");
}

function computeContentDelta(runningText, token) {
    const value = displayToken(token);
    if (!value) return "";
    if (!runningText) return value.charAt(0).toUpperCase() + value.slice(1);
    if (/^[,.;:!?%\]]/.test(value) || /^['\u2019]/.test(value)) return value;
    return ` ${value}`;
}

function countSentences(text) {
    return String(text)
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter(Boolean).length;
}

// ── Similarity / scoring ────────────────────────────────────────────

function lcs(left, right) {
    const a = [...String(left ?? "")];
    const b = [...String(right ?? "")];
    if (!a.length || !b.length) return 0;

    const table = Array.from({ length: a.length + 1 }, () =>
        new Array(b.length + 1).fill(0),
    );

    for (let r = 1; r <= a.length; r++) {
        for (let c = 1; c <= b.length; c++) {
            table[r][c] =
                a[r - 1] === b[c - 1] ?
                table[r - 1][c - 1] + 1 :
                Math.max(table[r - 1][c], table[r][c - 1]);
        }
    }
    return table[a.length][b.length];
}

function weightedLcs(left, right) {
    const a = String(left ?? "");
    const b = String(right ?? "");
    if (!a.length || !b.length) return 0;
    return (lcs(a, b) * Math.min(a.length, b.length)) / Math.max(a.length, b.length);
}

function followCount(model, key) {
    return model[key] ? Object.keys(model[key]).length : 0;
}

function contextBoost(tokens, key) {
    const recent = tokens.slice(-20).join(" ");
    if (!recent) return 0;
    return weightedLcs(recent, key) / Math.max(1, key.length);
}

function findClosestKey(source, context, trimodelKeys) {
    let bestKey = "";
    let bestScore = 0;
    const recent = context.slice(-80).join(" ");

    for (const key of trimodelKeys) {
        const overlap = weightedLcs(key, source);
        const repeatPenalty = 1 + recent.split(key).length - 1;
        const score = overlap / repeatPenalty;
        if (score > bestScore) {
            bestScore = score;
            bestKey = key;
        }
    }
    return bestKey;
}

function selectCandidate(matches, model, context) {
    let bestKey = "";
    let bestScore = -Infinity;
    const recent = context.slice(-80).join(" ");

    for (const [key, weight] of Object.entries(matches ?? {})) {
        const repeatPenalty = 1 + recent.split(key).length - 1;
        const score =
            ((Number(weight) || 0) +
                followCount(model, key) * 0.015 +
                contextBoost(context, key) * 2) /
            repeatPenalty;

        if (score > bestScore || (score === bestScore && Math.random() < 0.15)) {
            bestScore = score;
            bestKey = key;
        }
    }
    return bestKey;
}

function randomSeedTokens(models) {
    const keys = models.trimodelKeys;
    const key = keys[Math.floor(Math.random() * Math.max(1, keys.length))] || "";
    return key.split(" ").filter(Boolean);
}

function getNextToken(context, models) {
    if (!context.length) {
        context.push(...randomSeedTokens(models));
    }

    const previous = context.at(-2) ?? "";
    const current = context.at(-1) ?? "";
    const trigramKey = `${previous} ${current}`.trim();

    let model = models.trimodel;
    let matches = model[trigramKey];

    if (!matches) {
        model = models.bimodel;
        matches = model[current];
    }

    if (!matches) {
        model = models.trimodel;
        const fuzzyKey = findClosestKey(trigramKey || current, context, models.trimodelKeys);
        matches = model[fuzzyKey];
    }

    return selectCandidate(matches, model, context);
}

// ── Model loader (cached in module scope across invocations) ────────

let cachedModels = null;
let loadPromise = null;

async function fetchJson(url) {
    const res = await wixFetch(url, { method: "GET" });
    if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: ${res.status}`);
    }
    return res.json();
}

function loadModels() {
    if (cachedModels) return Promise.resolve(cachedModels);
    if (loadPromise) return loadPromise;

    loadPromise = Promise.all([
        fetchJson(`${MODEL_BASE_URL}/trimodel.json.txt`),
        fetchJson(`${MODEL_BASE_URL}/bimodel.json.txt`),
    ]).then(([trimodel, bimodel]) => {
        cachedModels = {
            trimodel,
            bimodel,
            trimodelKeys: Object.keys(trimodel),
        };
        loadPromise = null;
        return cachedModels;
    });

    return loadPromise;
}

// Kick off model loading at module init so subsequent requests are warm.
try { global.loadModles = loadModels(); } catch { /* will retry on first request */ }

// ── Helpers ─────────────────────────────────────────────────────────

function tokenize(text) {
    return String(text ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function messagesToContext(messages) {
    const tokens = [];
    for (const msg of messages) {
        if (typeof msg.content === "string") {
            tokens.push(...tokenize(msg.content));
        }
    }
    return tokens;
}

function sseEvent(data) {
    return `data: ${JSON.stringify(data)}\n\n`;
}

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Endpoints ───────────────────────────────────────────────────────

// GET /_functions/health
export function get_health() {
    return ok({
        headers: CORS,
        body: { status: "ok", model: MODEL_ID },
    });
}

// GET /_functions/v1Models
export function get_v1Models() {
    return ok({
        headers: CORS,
        body: {
            object: "list",
            data: [{ id: MODEL_ID, object: "model", created: 1700000000, owned_by: "local" }],
        },
    });
}

// POST /_functions/v1ChatCompletions
export async function post_v1ChatCompletions(request) {
    try {
        await global.loadModles;
        const body = await request.body.json();
        const messages = body.messages ?? [];
        const maxTokens = Math.max(8, Number(body.max_tokens ?? body.max_completion_tokens ?? 256));
        const maxSentences = Math.max(1, Number(body.max_sentences ?? 8));
        const wantStream = body.stream === true;

        const models = await loadModels();
        const context = messagesToContext(messages);
        const localContext = [...context];
        const generated = [];

        const completionId = `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const created = Math.floor(Date.now() / 1000);

        // Generate tokens
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

        const finishReason = generated.length >= maxTokens ? "length" : "stop";
        const usage = {
            prompt_tokens: context.length,
            completion_tokens: generated.length,
            total_tokens: context.length + generated.length,
        };

        // ── Non-streaming response ────────────────────────────────────
        if (!wantStream) {
            const text = tokensToText(generated).trim();

            // Build per-token content deltas so a proxy can re-stream them
            const deltas = [];
            let runText = "";
            for (const token of generated) {
                const d = computeContentDelta(runText, token);
                runText += d;
                deltas.push(d);
            }

            return ok({
                headers: { ...CORS, "Content-Type": "application/json" },
                body: {
                    id: completionId,
                    object: "chat.completion",
                    created,
                    model: MODEL_ID,
                    choices: [{
                        index: 0,
                        message: { role: "assistant", content: text },
                        finish_reason: finishReason,
                    }, ],
                    usage,
                    _deltas: deltas,
                },
            });
        }

        // ── Streaming via Wix Realtime ─────────────────────────────
        // Publish OpenAI chunks to a Realtime channel so the client
        // receives them over WebSocket — no HTTP proxy buffering.
        const streamId = completionId;
        const channel = { name: "completions", resourceId: streamId };

        // Publish chunks in the background (fire-and-forget).
        // We don't await this — the HTTP response returns immediately.
        const publishStream = (async () => {
            try {
                // Role announcement
                await wixRealtimeBackend.publish(channel, {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: MODEL_ID,
                    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
                });

                // One chunk per token
                let runningText = "";
                for (const token of generated) {
                    const contentDelta = computeContentDelta(runningText, token);
                    runningText += contentDelta;

                    await wixRealtimeBackend.publish(channel, {
                        id: completionId,
                        object: "chat.completion.chunk",
                        created,
                        model: MODEL_ID,
                        choices: [{ index: 0, delta: { content: contentDelta }, finish_reason: null }],
                    });
                }

                // Final chunk with finish_reason and usage
                await wixRealtimeBackend.publish(channel, {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: MODEL_ID,
                    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                    usage,
                });

                // Signal stream is done
                await wixRealtimeBackend.publish(channel, { done: true });
            } catch (err) {
                await wixRealtimeBackend.publish(channel, {
                    error: { message: err?.message ?? String(err), type: "server_error" },
                    done: true,
                }).catch(() => {});
            }
        })();

        // Let the background publishing continue
        publishStream.catch(() => {});

        // Return immediately with stream metadata so client can subscribe
        return ok({
            headers: { ...CORS, "Content-Type": "application/json" },
            body: {
                id: completionId,
                object: "chat.completion.stream",
                created,
                model: MODEL_ID,
                stream: {
                    channel: "completions",
                    resourceId: streamId,
                },
            },
        });
    } catch (err) {
        return serverError({
            headers: CORS,
            body: { error: { message: err?.message ?? String(err), type: "server_error" } },
        });
    }
}

export async function get_sheetFetch(request) {
    try {
        const url = new URL(request.url);
        const payloadStr = url.searchParams.get('payload');
        const requestPayload = JSON.parse(decodeURIComponent(payloadStr));

        // Decode base64 body if present
        const fetchOptions = { ...requestPayload };
        if (requestPayload.body) {
            fetchOptions.body = Buffer.from(requestPayload.body, 'base64');
        }

        const res = await fetch(new Request(requestPayload.url, fetchOptions));

        // Read body as ArrayBuffer and re-encode as base64
        const resBuffer = await res.arrayBuffer();
        const body = Buffer.from(resBuffer).toString('base64');

        // Build response payload mirroring the original worker
        const responsePayload = {};
        for (const key in res) {
            responsePayload[key] = res[key];
        }
        responsePayload.body = body;

        const headers = {};
        res.headers.forEach((value, key) => { headers[key] = value; });
        responsePayload.headers = headers;

        const encoded = Buffer.from(JSON.stringify(responsePayload)).toString('base64');
        const chunked = splitStringIntoGroups(encoded, 40000);

        return ok({
            body: chunked,
            headers: { 'Content-Type': 'text/plain' }
        });
    } catch (e) {
        return serverError({
            body: String(e?.message),
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

function splitStringIntoGroups(str, size) {
    const arr = [];
    for (let i = 0; i < str.length; i += size) {
        arr.push(str.substring(i, i + size));
    }
    return arr.join('\n');
}

// ── Runtime probes ──────────────────────────────────────────────────
// Deploy these, hit each endpoint, and report back what you see.

function safeStr(val, depth = 0) {
    if (depth > 3) return '…';
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`;
    if (typeof val === 'symbol') return val.toString();
    if (typeof val !== 'object') return String(val);
    if (Array.isArray(val)) return `[Array(${val.length})]`;
    const ctor = val?.constructor?.name ?? 'Object';
    try {
        const keys = Reflect.ownKeys(val).slice(0, 30);
        return `{${ctor}: ${keys.map(k => String(k)).join(', ')}}`;
    } catch {
        return `{${ctor}}`;
    }
}

function deepProbe(obj, depth = 0, seen = new WeakSet()) {
    if (depth > 2 || obj == null || typeof obj !== 'object') return safeStr(obj, depth);
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    const result = {};
    for (const key of Reflect.ownKeys(obj).slice(0, 40)) {
        try {
            result[String(key)] = safeStr(obj[key], depth + 1);
        } catch (e) {
            result[String(key)] = `[Error: ${e.message}]`;
        }
    }
    return result;
}

// Probe 1: active handles — look for sockets, servers, timers
export function get_probe1() {
    try {
        const handles = process._getActiveHandles();
        const info = handles.map((h, i) => ({
            index: i,
            constructor: h?.constructor?.name,
            keys: (() => { try { return Reflect.ownKeys(h).slice(0, 25).map(String); } catch { return []; } })(),
            type: h?._type ?? h?.type ?? null,
            fd: h?._handle?.fd ?? h?.fd ?? null,
            localAddress: h?.localAddress ?? null,
            localPort: h?.localPort ?? null,
            remoteAddress: h?.remoteAddress ?? null,
            remotePort: h?.remotePort ?? null,
            writable: h?.writable ?? null,
            readable: h?.readable ?? null,
        }));
        return ok({ headers: CORS, body: { handleCount: handles.length, handles: info } });
    } catch (e) {
        return serverError({ headers: CORS, body: { error: e.message, stack: e.stack } });
    }
}

// Probe 2: active requests — pending async ops
export function get_probe2() {
    try {
        const reqs = process._getActiveRequests();
        const info = reqs.map((r, i) => ({
            index: i,
            constructor: r?.constructor?.name,
            keys: (() => { try { return Reflect.ownKeys(r).slice(0, 20).map(String); } catch { return []; } })(),
        }));
        return ok({ headers: CORS, body: { requestCount: reqs.length, requests: info } });
    } catch (e) {
        return serverError({ headers: CORS, body: { error: e.message } });
    }
}

// Probe 3: deep-inspect the Wix request object
export function get_probe3(request) {
    try {
        const info = {
            constructorName: request?.constructor?.name,
            protoChain: [],
            ownKeys: deepProbe(request),
        };
        let proto = Object.getPrototypeOf(request);
        while (proto && proto !== Object.prototype) {
            info.protoChain.push({
                name: proto.constructor?.name,
                keys: Reflect.ownKeys(proto).slice(0, 30).map(String),
            });
            proto = Object.getPrototypeOf(proto);
        }
        return ok({ headers: CORS, body: info });
    } catch (e) {
        return serverError({ headers: CORS, body: { error: e.message, stack: e.stack } });
    }
}

// Probe 4: try require('http') and see what's available
export function get_probe4() {
    const results = {};
    const modules = ['http', 'http2', 'net', 'stream', 'express', 'koa', 'fastify'];
    for (const mod of modules) {
        try {
            const m = typeof require !== 'undefined' ? require(mod) : null;
            results[mod] = m ? Object.keys(m).slice(0, 30) : 'require not available';
        } catch (e) {
            results[mod] = `Error: ${e.message}`;
        }
    }
    // also try dynamic import
  //  results._importMeta = typeof import.meta === 'object' ? Object.keys(import.meta) : 'N/A';
    return ok({ headers: CORS, body: results });
}

// Probe 5: walk global for server-like objects
export function get_probe5() {
    try {
        const interesting = {};
        for (const key of Reflect.ownKeys(global).slice(0, 100)) {
            const val = global[key];
            const t = typeof val;
            if (t === 'function' || t === 'object') {
                interesting[String(key)] = safeStr(val);
            }
        }
        return ok({ headers: CORS, body: interesting });
    } catch (e) {
        return serverError({ headers: CORS, body: { error: e.message } });
    }
}

// Probe 6: inspect process.stdout — is it a socket/TTY?
export function get_probe6() {
    try {
        const out = process.stdout;
        const err = process.stderr;
        return ok({
            headers: CORS,
            body: {
                stdout: {
                    constructor: out?.constructor?.name,
                    isTTY: out?.isTTY,
                    writable: out?.writable,
                    fd: out?.fd,
                    keys: Reflect.ownKeys(out).slice(0, 30).map(String),
                },
                stderr: {
                    constructor: err?.constructor?.name,
                    isTTY: err?.isTTY,
                    writable: err?.writable,
                    fd: err?.fd,
                    keys: Reflect.ownKeys(err).slice(0, 30).map(String),
                },
            },
        });
    } catch (e) {
        return serverError({ headers: CORS, body: { error: e.message } });
    }
}

// Probe 7: inspect what ok() and response() actually return
export function get_probe7() {
    try {
        const r = response({ status: 200, headers: { 'X-Test': '1' }, body: 'hello' });
        return ok({
            headers: CORS,
            body: {
                responseObj: {
                    constructor: r?.constructor?.name,
                    keys: deepProbe(r),
                    protoChain: (() => {
                        const chain = [];
                        let p = Object.getPrototypeOf(r);
                        while (p && p !== Object.prototype) {
                            chain.push({ name: p.constructor?.name, keys: Reflect.ownKeys(p).slice(0, 20).map(String) });
                            p = Object.getPrototypeOf(p);
                        }
                        return chain;
                    })(),
                },
            },
        });
    } catch (e) {
        return serverError({ headers: CORS, body: { error: e.message, stack: e.stack } });
    }
}

// Probe 8: try to find raw req/res via active handles during a request
export async function get_probe8(request) {
    try {
        const handles = process._getActiveHandles();
        const sockets = handles.filter(h =>
            h?.constructor?.name === 'Socket' ||
            h?.constructor?.name === 'TLSSocket' ||
            h?.constructor?.name === 'TCP' ||
            (h?.writable === true && h?.remoteAddress)
        );
        const servers = handles.filter(h =>
            h?.constructor?.name === 'Server' ||
            h?.constructor?.name === 'HTTPServer' ||
            typeof h?.listen === 'function'
        );

        // For servers, check if they have _connections or connections
        const serverInfo = servers.map(s => ({
            constructor: s?.constructor?.name,
            listening: s?.listening,
            address: (() => { try { return s.address(); } catch { return null; } })(),
            connections: s?._connections ?? s?.connections ?? null,
            keys: Reflect.ownKeys(s).slice(0, 40).map(String),
        }));

        // For sockets, check if they have a _httpMessage (the ServerResponse)
        const socketInfo = sockets.map(s => ({
            constructor: s?.constructor?.name,
            remoteAddress: s?.remoteAddress,
            remotePort: s?.remotePort,
            localPort: s?.localPort,
            hasHttpMessage: !!s?._httpMessage,
            httpMessageType: s?._httpMessage?.constructor?.name,
            httpMessageKeys: s?._httpMessage ? Reflect.ownKeys(s._httpMessage).slice(0, 30).map(String) : null,
            httpMessageWritable: s?._httpMessage?.writable,
            httpMessageHeadersSent: s?._httpMessage?.headersSent,
            parser: s?.parser?.constructor?.name ?? null,
        }));

        return ok({
            headers: CORS,
            body: {
                socketCount: sockets.length,
                serverCount: servers.length,
                sockets: socketInfo,
                servers: serverInfo,
            },
        });
    } catch (e) {
        return serverError({ headers: CORS, body: { error: e.message, stack: e.stack } });
    }
}

// ── Raw ServerResponse hijack ───────────────────────────────────────

/**
 * Find the raw http.ServerResponse for the current request by scanning
 * active handles for a Socket whose _httpMessage hasn't sent headers yet.
 */
function findRawResponse() {
    const handles = process._getActiveHandles();
    for (const h of handles) {
        const res = h?._httpMessage;
        if (
            res &&
            res.constructor?.name === 'ServerResponse' &&
            res.writable &&
            !res.headersSent
        ) {
            return res;
        }
    }
    return null;
}

/**
 * Hijack the raw ServerResponse to stream SSE.
 * Returns a Promise that resolves when the stream is done.
 * The caller should return a never-resolving promise to Wix so Wix
 * doesn't try to write its own response to the now-finished socket.
 */
function streamSSE(res, chunks) {
    return new Promise((resolve) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });

        let i = 0;
        function next() {
            if (i >= chunks.length) {
                res.end();
                resolve();
                return;
            }
            const chunk = chunks[i++];
            res.write(chunk, () => setTimeout(next, 0));
        }
        next();
    });
}

// Probe 9: live streaming test — should trickle 5 SSE events
export async function get_probe9() {
    const raw = findRawResponse();
    if (!raw) {
        return serverError({ headers: CORS, body: { error: 'Could not find raw ServerResponse' } });
    }

    const chunks = [];
    for (let i = 1; i <= 5; i++) {
        chunks.push(`data: {"seq":${i},"msg":"chunk ${i} of 5"}\n\n`);
    }
    chunks.push('data: [DONE]\n\n');

    await streamSSE(raw, chunks);

    // Return a promise that never resolves so Wix doesn't try to
    // write its own response on the now-closed socket.
    return new Promise(() => {});
}

// Probe 10: try multiple proxy-busting strategies
// Strategy A: massive 32KB padding to exceed GFE buffer threshold
// Strategy B: cork/uncork to force TCP segment flush
// Strategy C: Content-Encoding: identity to prevent proxy compression buffering
export async function get_probe10() {
    const raw = findRawResponse();
    if (!raw) {
        return serverError({ headers: CORS, body: { error: 'Could not find raw ServerResponse' } });
    }

    const sock = raw.socket;
    if (sock) {
        sock.setNoDelay(true);
        sock.setTimeout(0);
    }

    // Do NOT set Transfer-Encoding manually — let Node handle chunked framing
    raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform, must-revalidate',
        'Connection': 'keep-alive',
        'Content-Encoding': 'identity',      // prevent proxy gzip buffering
        'X-Accel-Buffering': 'no',           // nginx (just in case)
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
    });
    raw.flushHeaders();

    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    // 32KB padding — some proxies only start flushing after N bytes
    const pad = `: ${'x'.repeat(32768)}\n\n`;
    raw.write(pad);

    // cork/uncork forces a TCP push
    if (sock && typeof sock.uncork === 'function') {
        sock.cork();
        sock.uncork();
    }

    await delay(100);

    for (let i = 1; i <= 8; i++) {
        const chunk = `data: {"seq":${i},"ts":${Date.now()}}\n\n`;
        raw.write(chunk);
        // Try cork/uncork flush after each write
        if (sock && typeof sock.uncork === 'function') {
            sock.cork();
            sock.uncork();
        }
        await delay(750);
    }

    raw.end('data: [DONE]\n\n');
    return new Promise(() => {});
}

// Probe 12: test if Wix's own response() can stream a Node Readable
export async function get_probe12() {
    const { Readable } = require('stream');

    const readable = new Readable({
        read() {}
    });

    // Push chunks on a timer
    let i = 0;
    const iv = setInterval(() => {
        i++;
        if (i <= 6) {
            readable.push(`data: {"seq":${i},"ts":${Date.now()}}\n\n`);
        } else {
            readable.push('data: [DONE]\n\n');
            readable.push(null);
            clearInterval(iv);
        }
    }, 500);

    return response({
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            'Content-Encoding': 'identity',
            ...CORS,
        },
        body: readable,
    });
}

// Probe 13: test chunked response via raw socket.write (bypass HTTP framing)
// This writes raw HTTP/1.1 chunked transfer directly to the TCP socket
export async function get_probe13() {
    const raw = findRawResponse();
    if (!raw) {
        return serverError({ headers: CORS, body: { error: 'No raw response' } });
    }
    const sock = raw.socket;
    if (!sock) {
        return serverError({ headers: CORS, body: { error: 'No socket' } });
    }
    sock.setNoDelay(true);

    // Detach the HTTP parser so we can write raw
    raw.detachSocket(sock);

    // Write raw HTTP response headers
    sock.write(
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: text/event-stream; charset=utf-8\r\n' +
        'Cache-Control: no-cache, no-store\r\n' +
        'Connection: close\r\n' +
        'Content-Encoding: identity\r\n' +
        'X-Accel-Buffering: no\r\n' +
        'Access-Control-Allow-Origin: *\r\n' +
        '\r\n'
    );

    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    for (let i = 1; i <= 8; i++) {
        sock.write(`data: {"seq":${i},"ts":${Date.now()}}\n\n`);
        await delay(750);
    }

    sock.write('data: [DONE]\n\n');
    sock.end();
    return new Promise(() => {});
}

// Probe 11: diagnose what sits between us and the client
export function get_probe11() {
    const raw = findRawResponse();
    const sock = raw?.socket;
    return ok({
        headers: CORS,
        body: {
            rawFound: !!raw,
            hasFlush: typeof raw?.flush === 'function',
            socketType: sock?.constructor?.name,
            socketNoDelay: sock?.noDelay,
            socketKeys: sock ? Reflect.ownKeys(sock).slice(0, 20).map(String) : null,
            reqHeaders: raw?.req?.headers ?? null,
            reqRawHeaders: raw?.req?.rawHeaders?.slice(0, 40) ?? null,
        },
    });
}