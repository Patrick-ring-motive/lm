// engine.js — Pure n-gram generation logic.
// No I/O, no platform APIs. Receives loaded model dictionaries and returns tokens.

/** @typedef {{ trimodel: Record<string,Record<string,number>>, bimodel: Record<string,Record<string,number>>, trimodelKeys: string[] }} Models */

// ── Token formatting ────────────────────────────────────────────────

export function safeNormalizeToken(token) {
  try {
    return JSON.parse(token);
  } catch {
    return String(token ?? "");
  }
}

export function displayToken(token) {
  return String(safeNormalizeToken(token)).replaceAll("_", " ").trim();
}

export function appendTokenToText(text, token) {
  const value = displayToken(token);
  if (!value) return text;
  if (!text) return value.charAt(0).toUpperCase() + value.slice(1);
  if (/^[,.;:!?%\]]/.test(value) || /^['\u2019]/.test(value)) {
    return `${text.trimEnd()}${value}`;
  }
  return `${text} ${value}`;
}

export function tokensToText(tokens) {
  return tokens.reduce((text, token) => appendTokenToText(text, token), "");
}

export function computeContentDelta(runningText, token) {
  const value = displayToken(token);
  if (!value) return "";
  if (!runningText) return value.charAt(0).toUpperCase() + value.slice(1);
  if (/^[,.;:!?%\]]/.test(value) || /^['\u2019]/.test(value)) return value;
  return ` ${value}`;
}

export function countSentences(text) {
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

  const table = Array.from({
      length: a.length + 1
    }, () =>
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

// ── Public generation API ───────────────────────────────────────────

/**
 * Pick a random seed from the trigram keys.
 * @param {Models} models
 */
export function randomSeedTokens(models) {
  const keys = models.trimodelKeys;
  const key = keys[Math.floor(Math.random() * Math.max(1, keys.length))] || "";
  return key.split(" ").filter(Boolean);
}

/**
 * Return the next token given a context window.
 * @param {string[]} context — mutable; may be seeded if empty.
 * @param {Models} models
 */
export function getNextToken(context, models) {
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
