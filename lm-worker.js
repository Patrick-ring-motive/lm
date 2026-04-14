let words100 = “years|ways|worlds|live|lives|hands|parts|children|eyes|places|weeks|cases|points|numbers|groups|problems|facts|times|days|men|women|one|two|three|four|five|six|seven|eight|nine|ten|zero|none|size|sized|sizes|sizing|calls|called|calling|leaves|lefts|leaving|try|tries|trying|feels|felt|feeling|seems|seemed|seeming|asks|asked|asking|tells|told|telling|finds|found|finding|looks|looked|looking|see|sees|seeing|saw|knows|knowing|knew|get|gets|got|getting|works|worked|working|I|a|able|about|after|all|also|am|an|and|any|are|as|ask|at|back|bad|be|because|been|being|bes|big|but|by|call|came|can|case|child|come|comes|coming|company|could|day|different|do|does|doing|done|early|even|eye|fact|feel|few|find|first|for|from|gave|get|give|gives|giving|go|goes|going|good|government|great|group|had|hand|has|have|he|her|high|him|his|how|if|important|in|into|is|it|its|just|know|large|last|leave|life|like|little|long|look|make|makes|making|man|me|most|my|new|next|no|not|now|number|of|old|on|one|only|or|other|our|out|over|own|part|people|person|place|point|problem|public|right|said|same|saw|say|says|see|seeing|seem|sees|shall|she|should|small|so|some|take|takes|taking|tell|than|that|the|their|them|then|there|these|they|thing|think|thinking|thinks|this|thought|time|to|took|try|two|up|us|use|used|uses|using|want|wanted|wanting|wants|was|way|we|week|well|went|were|what|when|which|who|will|with|woman|work|world|would|year|yes|yet|you|young|your”;
words100 = words100
.split(”|”)
.filter((x) => x.length <= 5)
.join(”|”);

const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(
(typeof navigator !== “undefined” && navigator.userAgent) || “”
);

const FIND_KEY_DEADLINE_MS = isMobile ? 80 : 400;

const workerState = {
trimodel: null,
bimodel: null,
trimodelKeys: [],
};

const activeStreams = new Map();

function safeNormalizeToken(token) {
try {
return JSON.parse(token);
} catch {
return String(token ?? “”);
}
}

function displayToken(token) {
return String(safeNormalizeToken(token)).replaceAll(”_”, “ “).trim();
}

function appendTokenToText(text, token) {
const value = displayToken(token);
if (!value) {
return text;
}

if (!text) {
return value.charAt(0).toUpperCase() + value.slice(1);
}

if (/^[,.;:!?%]]/.test(value) || /^[’’]/.test(value)) {
return `${text.trimEnd()}${value}`;
}

return `${text} ${value}`;
}

function tokensToText(tokens) {
return tokens.reduce((text, token) => appendTokenToText(text, token), “”);
}

function computeContentDelta(runningText, token) {
const value = displayToken(token);
if (!value) {
return “”;
}

if (!runningText) {
return value.charAt(0).toUpperCase() + value.slice(1);
}

if (/^[,.;:!?%]]/.test(value) || /^[’\u2019]/.test(value)) {
return value;
}

return ` ${value}`;
}

function countSentences(text) {
return String(text)
.split(/[.!?]+/)
.map((chunk) => chunk.trim())
.filter(Boolean).length;
}
const lcsMemo = {};
function lcs(seq1, seq2) {
“use strict”;
seq1 = […(seq1 ?? [])];
seq2 = […(seq2 ?? [])];
if (seq2.length > seq1.length) {
[seq1, seq2] = [seq2, seq1];
}
const arr1 = seq1;
const arr2 = seq2;
const dp = Array(arr1.length + 1)
.fill(0)
.map(() => new Uint8Array(arr2.length + 1));
const dp_length = dp.length;
for (let i = 1; i !== dp_length; i++) {
const dpi_length = dp[i].length;
for (let x = 1; x !== dpi_length; x++) {
if (arr1[i - 1] === arr2[x - 1]) {
dp[i][x] = dp[i - 1][x - 1] + 1;
} else {
dp[i][x] = Math.max(dp[i][x - 1], dp[i - 1][x]);
}
}
}
const lcsValue = dp[arr1.length][arr2.length];
return lcsValue;
};
function weightedLcs(left, right) {
const a = String(left ?? “”);
const b = String(right ?? “”);
if (!a.length || !b.length) {
return 0;
}
return (lcs(a, b) * Math.min(a.length, b.length)) / Math.max(a.length, b.length);
}

function followCount(model, key) {
return model[key] ? Object.keys(model[key]).length : 0;
}

function contextBoost(tokens, key) {
const recent = tokens.slice(-20).join(” “);
if (!recent) {
return 0;
}
return weightedLcs(recent, key) / Math.max(1, key.length);
}

function findClosestKey(source, context) {
source = String(source);
let bestKey = “”;
let bestScore = 0;
const recent = context.slice(-80).join(” “);
const deadline = performance.now() + FIND_KEY_DEADLINE_MS;

for (let i = 0; i < workerState.trimodelKeys.length; i++) {
if ((i & 63) === 0 && performance.now() > deadline) {
break;
}


const key = workerState.trimodelKeys[i];
const sub = lcs(key, source);
const overlap = sub * Math.min(key.length, source.length) / Math.max(key.length, source.length);
const repeatPenalty = 1 + recent.split(key).length - 1;
const score = overlap / repeatPenalty;

if (score > bestScore) {
  bestScore = score;
  bestKey = key;
  if (sub >= Math.floor(0.8 * Math.max(key.length, source.length))) {
    break;
  }
}


}

return bestKey;
}

const actors =
“Aragorn|Frodo|Gandalf|Legolas|Gimli|Boromir|Samwise|Merry|Pippin|Faramir|Denethor|Elrond|Galadriel|Saruman”
.toLowerCase()
.split(”|”);
const activeActors = {};

function getActorBoost(model, key) {
if (!model[key]) return 0;
let score = 0;
const smk = String(model[key]).toLowerCase();
for (const actor in activeActors) {
if (smk.includes(actor)) {
score += 0.2;
}
score += 0.2 * ((lcs(smk, actor) * actor.length) / smk.length);
}
return score;
}

function selectCandidate(matches, model, context, trigramKey=’’) {
let bestKey = “”;
let bestScore = -Infinity;
const recent = context.slice(-80).join(” “);

for (const [key, weight] of Object.entries(matches ?? {})) {
const repeatPenalty = 1 + recent.split(key).length - 1;
const score =
((Number(weight) || 0) +
getActorBoost(model, key) +
followCount(model, key) * 0.015 +
contextBoost(context, key) * 2) /
repeatPenalty;

```
if (score > bestScore || (score === bestScore && Math.random() < 0.15)) {
  bestScore = score;
  bestKey = key;
}
```

}
let lk;
let keyMatch;
try{
keyMatch = String(bestKey);
lk = keyMatch.toLowerCase();
}catch(e){
console.warn(e);
}
for (const actor of actors) {
if (lk.includes(actor)) {
activeActors[actor] = 20;
}
}
for (const actor in activeActors) {
activeActors[actor]–;
if (activeActors[actor] <= 0) {
delete activeActors[actor];
}
}
if (/[A-Z]/.test(keyMatch) && !/?|.|!/.test(trigramKey)) {
activeActors[keyMatch] = 20;
}
const potentialActors = String(keyMatch).split(/[^a-zA-Z]+/).filter(Boolean);
for(const a of potentialActors){
if(a.length > 5 && !words100.includes(a)){
activeActors[a] = 20;
}
}
delete activeActors[“I”];
return bestKey;
}

function randomSeedTokens() {
const key =
workerState.trimodelKeys[
Math.floor(Math.random() * Math.max(1, workerState.trimodelKeys.length))
] || “”;

return key.split(” “).filter(Boolean);
}

function getNextToken(context) {
if (!context.length) {
context.push(…randomSeedTokens());
}

const previous = context[context.length - 2] ?? “”;
const current = context[context.length - 1] ?? “”;
const trigramKey = `${previous} ${current}`.trim();

let model = workerState.trimodel;
let matches = model[trigramKey];

if (!matches) {
model = workerState.bimodel;
matches = model[current];
}

if (!matches) {
model = workerState.trimodel;
const fuzzyKey = findClosestKey(trigramKey || current, context);
matches = model[fuzzyKey];
}

return selectCandidate(matches, model, context, trigramKey);
}

async function fetchModelJson(path) {
const response = await fetch(path);
if (!response.ok) {
throw new Error(`Unable to load ${path}: ${response.status}`);
}

if (path.endsWith(”.gz”)) {
if (!response.body || typeof DecompressionStream !== “function”) {
throw new Error(“Gzip decompression is not available in this browser.”);
}
const stream = response.body.pipeThrough(new DecompressionStream(“gzip”));
return JSON.parse(await new Response(stream).text());
}

return JSON.parse(await response.text());
}

async function loadModel(stem) {
try {
return await fetchModelJson(`${stem}.gz`);
} catch {
return await fetchModelJson(stem);
}
}

async function initializeModels() {
const [trimodel, bimodel] = await Promise.all([
loadModel(“trimodel.json.txt”),
loadModel(“bimodel.json.txt”),
]);

workerState.trimodel = trimodel;
workerState.bimodel = bimodel;
workerState.trimodelKeys = Object.keys(trimodel);
}

const initPromise = initializeModels();

(async () => {
try {
await initPromise;
postMessage({ type: “ready” });
} catch (error) {
postMessage({
type: “ready-error”,
error: error?.message ?? String(error),
});
}
})();

async function streamGeneration({ streamId, context = [], maxTokens = 72, maxSentences = 4 }) {
const localContext = Array.isArray(context) ? […context] : [];
const generated = [];
const tokenLimit = Math.max(8, Number(maxTokens) || 72);
const sentenceLimit = Math.max(1, Number(maxSentences) || 4);
const promptTokens = localContext.length;

const completionId = `chatcmpl-${crypto.randomUUID()}`;
const created = Math.floor(Date.now() / 1000);
const modelName = “lm-ngram”;
let runningText = “”;
let finishReason = “stop”;

// Initial chunk: role announcement
postMessage({
type: “stream-chunk”,
streamId,
chunk: {
id: completionId,
object: “chat.completion.chunk”,
created,
model: modelName,
choices: [{ index: 0, delta: { role: “assistant”, content: “” }, finish_reason: null }],
},
});

for (let index = 0; index < tokenLimit; index++) {
const controller = activeStreams.get(streamId);
if (!controller || controller.signal.aborted) {
return;
}


const token = getNextToken(localContext);
if (!token) {
  break;
}

localContext.push(token);
generated.push(token);

const contentDelta = computeContentDelta(runningText, token);
runningText += contentDelta;

postMessage({
  type: "stream-chunk",
  streamId,
  chunk: {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: modelName,
    choices: [{ index: 0, delta: { content: contentDelta }, finish_reason: null }],
    _token: token,
  },
});

const partialText = tokensToText(generated).trim();
if (countSentences(partialText) >= sentenceLimit && /[.!?]$/.test(displayToken(token))) {
  break;
}

if (index === tokenLimit - 1) {
  finishReason = "length";
}

await new Promise((resolve) => setTimeout(resolve, 0));


}

// Final chunk: finish reason and usage
postMessage({
type: “stream-chunk”,
streamId,
chunk: {
id: completionId,
object: “chat.completion.chunk”,
created,
model: modelName,
choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
usage: {
prompt_tokens: promptTokens,
completion_tokens: generated.length,
total_tokens: promptTokens + generated.length,
},
},
});

postMessage({ type: “stream-end”, streamId });
}

onmessage = async (event) => {
const data = event.data;
if (!data || typeof data !== “object”) {
return;
}

const { type, streamId } = data;

if (type === “stream-cancel”) {
const controller = activeStreams.get(streamId);
if (controller) {
controller.abort();
activeStreams.delete(streamId);
}
return;
}

if (type !== “stream-start”) {
return;
}

const controller = new AbortController();
activeStreams.set(streamId, controller);

try {
await initPromise;
await streamGeneration(data);
} catch (error) {
if (!controller.signal.aborted) {
postMessage({
type: “stream-error”,
streamId,
error: error?.message ?? String(error),
});
}
} finally {
activeStreams.delete(streamId);
}
};
