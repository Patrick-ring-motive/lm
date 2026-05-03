// Logging utility
function log(...args) {
  console.log('[builder.js]', ...args);
}
function pruneTopScores(model, topN = 5) {
  for (const key in model) {
    const nextMap = model[key];
    const entries = Object.entries(nextMap);

    if (entries.length <= topN) continue;

    entries.sort((a, b) => b[1] - a[1]); // highest score first

    const trimmed = {};
    for (let i = 0; i < topN; i++) {
      const [token, score] = entries[i];
      trimmed[token] = score;
    }

    model[key] = trimmed;
  }

  return model;
}
/**
 * Extracts the top 100 most frequent words from a string.
 * @param {string} text - The input text to analyze.
 * @param {string} locale - The BCP 47 language tag (default 'en').
 * @returns {string[]} - Array of the top 100 words.
 */
function getTopWords(text, locale = 'en') {
  if (!text) return [];

  // 1. Initialize the Intl Segmenter
  // 'granularity: word' allows us to iterate over word boundaries
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
  const segments = segmenter.segment(text);

  const wordCounts = new Map();

  // 2. Count frequencies
  for (const { segment, isWordLike } of segments) {
    // 'isWordLike' is crucial: it filters out spaces, punctuation, and symbols
    if (isWordLike) {
      const word = segment.toLowerCase();
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
  }

  // 3. Sort by frequency and take the top 100
  return Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1]) // Sort descending by count
    .slice(0, 100)               // Limit to 100
    .map(([word]) => word);      // Return only the words
}

(function initLogging(){
  log('builder.js started');
})();
(async()=>{

// builder.js
const { LocalLinter, createBinaryModuleFromUrl } = await import('harper.js');
const { pathToFileURL } = await import('url');
const path = await import('path');

const binary = createBinaryModuleFromUrl(
    pathToFileURL(path.resolve(__dirname, 'node_modules/harper.js/dist/harper_wasm_bg.wasm')).href
);

// Initialize ONCE at the top level or in a setup function
let globalLinter;

async function setupLinter() {
  log('setupLinter: initializing');
  globalLinter = new LocalLinter({ binary });
    await globalLinter.setup();
    
    // Set config once
    let config = await globalLinter.getLintConfig();
    await globalLinter.setLintConfig({
        ...config,
        SpellCheck: false, // You mentioned this is already off
        SentenceCapitalization: false,
        LongSentences: false
    });
    config = await globalLinter.getLintConfig();
    await globalLinter.setLintConfig({
        ...config,
        SpellCheck: false,
        Matcher: false, // Disables the heavy pattern-matching engine
        Correctness: true // Keeps basic grammar/punctuation fixes
    });
    log('setupLinter: finished');
}

await setupLinter();

async function harper(text) {
  log('harper: linting text', { length: text?.length });
  // Use the pre-warmed linter instance
  const lints = await globalLinter.lint(text);
  log('harper: lints returned', lints?.length);
  let correctedText = text;
  let applied = 0;

  const sortedLints = lints.sort((a, b) => b.span.start - a.span.start);
  for (const lint of sortedLints) {
    if (lint.suggestions?.length > 0) {
      correctedText = await globalLinter.applySuggestion(correctedText, lint, lint.suggestions[0]);
      applied++;
    }
  }
  log('harper: applied suggestions', applied);
  return correctedText;
}

async function processInBatches(lines, batchSize = 500) {
    const results = [];
    const allLines = lines.split("\n").map(x=>x.trim()).filter(Boolean);
    const allLinesLength = allLines.length;
  log('processInBatches: start', { totalLines: allLinesLength, batchSize });
    for (let i = 0; i < allLinesLength; i += batchSize) {
        const batch = allLines.slice(i, i + batchSize);
        // Join lines into one large string to minimize WASM call overhead
        const joinedText = batch.join('\n'); 
        
        const correctedBatch = await harper(joinedText);
        
        // Split back into lines
        results.push(...correctedBatch.split('\n').map(x=>x.trim()).filter(Boolean));
        
    log('processInBatches: progress', { processed: i + batch.length, total: allLinesLength });
    }
    return results.join('\n');
}

let words100 = "years|ways|worlds|live|lives|hands|parts|children|eyes|places|weeks|cases|points|numbers|groups|problems|facts|times|days|men|women|one|two|three|four|five|six|seven|eight|nine|ten|zero|none|size|sized|sizes|sizing|calls|called|calling|leaves|lefts|leaving|try|tries|trying|feels|felt|feeling|seems|seemed|seeming|asks|asked|asking|tells|told|telling|finds|found|finding|looks|looked|looking|see|sees|seeing|saw|knows|knowing|knew|get|gets|got|getting|works|worked|working|I|a|able|about|after|all|also|am|an|and|any|are|as|ask|at|back|bad|be|because|been|being|bes|big|but|by|call|came|can|case|child|come|comes|coming|company|could|day|different|do|does|doing|done|early|even|eye|fact|feel|few|find|first|for|from|gave|get|give|gives|giving|go|goes|going|good|government|great|group|had|hand|has|have|he|her|high|him|his|how|if|important|in|into|is|it|its|just|know|large|last|leave|life|like|little|long|look|make|makes|making|man|me|most|my|new|next|no|not|now|number|of|old|on|one|only|or|other|our|out|over|own|part|people|person|place|point|problem|public|right|said|same|saw|say|says|see|seeing|seem|sees|shall|she|should|small|so|some|take|takes|taking|tell|than|that|the|their|them|then|there|these|they|thing|think|thinking|thinks|this|thought|time|to|took|try|two|up|us|use|used|uses|using|want|wanted|wanting|wants|was|way|we|week|well|went|were|what|when|which|who|will|with|woman|work|world|would|year|yes|yet|you|young|your";
words100 = words100
  .split("|")
  .filter((x) => x.length <= 5)
  .join("|");
const norm = (str) => {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
};

const glueFixes = (text) => {
  log('glueFixes: called', { len: text?.length });
  return text
    .replaceAll(/\sthe\s+/g, " the_")
    .replace(/\sa\s+/g, " a_")
    .replace(/\san\s+/g, " an_");
};

// run **before** you split into tokens
const glueCommonPairs = (text) => {
  log('glueCommonPairs: called', { len: text?.length });
  const re = RegExp(`\\b(${words100})\\s+(${words100})\\b`, "g");
  let next = text,
    prev;
  let iterations = 0;
  do {
    prev = next;
    next = prev.replace(re, " $1_$2 ");
    iterations++;
  } while (next !== prev);
  log('glueCommonPairs: iterations', iterations);
  return next;
};

const glueCommonReverse = (text) => {
  log('glueCommonReverse: called', { len: text?.length });
  text = [...text].reverse().join("");
  const re = RegExp(`\\b(${[...words100].reverse().join("")})\\s+(${[...words100].reverse().join("")})\\b`, "g");
  let next = text,
    prev;
  let iterations = 0;
  do {
    prev = next;
    next = prev.replace(re, " $1_$2 ");
    iterations++;
  } while (next !== prev);
  log('glueCommonReverse: iterations', iterations);
  return [...next].reverse().join("");
};

const glueShortPairs = (text) => {
  log('glueShortPairs: called', { len: text?.length });
  const re = /\b([a-z]{1,3})\s+([a-z]{1,3})\b/g;
  let next = text,
    prev;
  let iterations = 0;
  do {
    prev = next;
    next = prev.replace(re, " $1_$2 ");
    iterations++;
  } while (next !== prev);
  log('glueShortPairs: iterations', iterations);
  return next;
};
const words = words100 + "|[a-z]{1,3}";
const gluePairs = (text) => {
  log('gluePairs: called', { len: text?.length });
  const re = RegExp(`\\b(${words})\\s+(${words})\\b`, "g");
  let next = text,
    prev;
  let iterations = 0;
  do {
    prev = next;
    next = prev.replace(re, " $1_$2 ");
    iterations++;
  } while (next !== prev);
  log('gluePairs: iterations', iterations);
  return next;
};

const revWords = [...words100].reverse().join("") + "|[a-z]{1,3}";
const glueReverse = (text) => {
  log('glueReverse: called', { len: text?.length });
  text = [...text].reverse().join("");
  const re = RegExp(`\\b(${words})\\s+(${words})\\b`, "g");
  let next = text,
    prev;
  let iterations = 0;
  do {
    prev = next;
    next = prev.replace(re, "$1_$2 ");
    iterations++;
  } while (next !== prev);
  log('glueReverse: iterations', iterations);
  return [...next].reverse().join("");
};


const glueShortReverse = (text) => {
  log('glueShortReverse: called', { len: text?.length });
  text = [...text].reverse().join("");
  let next = glueShortPairs(text);
  return [...next].reverse().join("");
};


const fixText = (text) => {
  return norm(text
   // .replace(/[^\-\_a-zA-Z\.\?\!,';\s\(\)]/g, " ")
    .replace(/(\s*\.)+/g, ".")
    .replace(/(\s*\?)+/g, "?")
    .replace(/(\s*\!)+/g, "!")
    .replace(/(\s*\,)+/g, ",")
    .replace(/\s+\./g, '.')
    .replace(/\s+,/g, ',')
    .replace(/[A-Z]{2,}/g, (x) => x[0] + x.slice(1).toLowerCase()));
};

function buildSGrams(text) {
  log('buildSGrams: called', { len: text?.length });
  const out = norm(fixText(text))
    .split(/(?<=[.!?,;])\s+/)
    .map((x) => x.trim().replace(/\s+/g, " "))
    .filter((x) => x);
  log('buildSGrams: returning', { sgrams: out.length });
  return out;
}

function buildNGrams(text, n = 3,type="normal") {
  if(!words100.recalc){
    words100 = new String(words100+'|'+getTopWords(text).join("|"));
    words100.recalc = true;
  }
  const model = {};
  text = fixText(text);
  log('buildNGrams: called', { len: text?.length, n });
  let tokens = (norm(
    
   `${glueShortPairs(text)} ${glueShortReverse(text)} ${glueShortPairs(glueFixes(fixText(text)))} ${glueShortReverse(glueFixes(fixText(text)))}`
   +` ${glueCommonPairs(text)} ${glueCommonReverse(text)} ${glueCommonPairs(glueFixes(fixText(text)))} ${glueCommonReverse(glueFixes(fixText(text)))}`
   +` ${gluePairs(text)} ${glueReverse(text)} ${text} ${gluePairs(glueFixes(fixText(text)))} ${glueReverse(glueFixes(fixText(text)))}`
 ))
    .split(/\s+/)
    .filter((x) => x?.trim?.());
  log('buildNGrams: tokens length', tokens.length);
  for (let i = 0; i < tokens.length - n + 1; i++) {
    const key = tokens
      .slice(i, i + n - 1)
      .join(" ")
      .trim();
    const next = tokens[i + n - 1];
    if(key.toLowerCase() === String(next).toLowerCase()) continue; // remove self loops which are common but not useful
    model[key] ??= {};
    model[key][next] = (model[key][next] || 0) + 1;
    if (i % 50000 === 0 && i > 0) log('buildNGrams: progress', { i, tokensLength: tokens.length });
  }
  const divisor = String(buildNGrams).split('text').length - 6;
  for (const key in model) {
    const modelKey = model[key];
    const length = modelKey?.length||0;
    for(let i=0;i!==length;++i){
      modelKey[i] = Math.ceil(modelKey[i]/divisor);
    }
  }
  return model;
}

function buildPrunedNGrams(text, n = 3) {
  const model = {};
  text = fixText(text);
  let tokens = norm(text)
    .split(/\s+/)
    .filter((x) => x?.trim?.());
  log('buildPrunedNGrams: tokens length', tokens.length);
  for (let i = 0; i < tokens.length - n + 1; i++) {
    const key = tokens
      .slice(i, i + n - 1)
      .join(" ")
      .trim();
    const next = tokens[i + n - 1];
    if(key.toLowerCase() === String(next).toLowerCase()) continue; // remove self loops which are common but not useful 
    model[key] ??= {};
    model[key][next] = (model[key][next] || 0) + 1;
    if (i % 50000 === 0 && i > 0) log('buildPrunedNGrams: progress', { i });
  }
  for (const key in model) {
    if (Object.keys(model[key]).length < 2) {
      delete model[key];
    }
  }
  return model;
}

function reverseBuildNGrams(text, n = 3) {
  const model = {};
  text = fixText(text);
  let tokens = norm(
      `${gluePairs(text)} ${glueReverse(text)} ${text} ${gluePairs(glueFixes(fixText(text)))} ${glueReverse(glueFixes(fixText(text)))}`,
    )
    .split(/\s+/)
    .reverse()
    .filter((x) => x?.trim?.());
  log('reverseBuildNGrams: tokens length', tokens.length);
  for (let i = 0; i < tokens.length - n + 1; i++) {
    const key = tokens
      .slice(i, i + n - 1)
      .join(" ")
      .trim();
    const next = tokens[i + n - 1];
    if(key.toLowerCase() === String(next).toLowerCase()) continue;// remove self loops which are common but not useful
    model[key] ??= {};
    model[key][next] = (model[key][next] || 0) + 1;
  }
  return model;
}

function reverseBuildPrunedNGrams(text, n = 3) {
  const model = {};
  text = fixText(text);
  let tokens = norm(text)
    .split(/\s+/)
    .reverse()
    .filter((x) => x?.trim?.());
  log('reverseBuildPrunedNGrams: tokens length', tokens.length);
  for (let i = 0; i < tokens.length - n + 1; i++) {
    const key = tokens
      .slice(i, i + n - 1)
      .join(" ")
      .trim();
    const next = tokens[i + n - 1];
  if(key.toLowerCase() === String(next).toLowerCase()) continue; // remove self loops which are common but not useful
    model[key] ??= {};
    model[key][next] = (model[key][next] || 0) + 1;
  }
  for (const key in model) {
    if (Object.keys(model[key]).length < 2) {
      delete model[key];
    }
  }
  return model;
}

const mergeModels = (...models) => {
  log('mergeModels: called', { models: models.length });
  const model = {};
  for (const m of models) {
    for (const key in m) {
      model[key] ??= {};
      for (const next in m[key]) {
        model[key][next] = Math.max(model[key][next] || 0, m[key][next] || 0);
      }
    }
  }
  log('mergeModels: merged keys', Object.keys(model).length);
  return model;
};
if (typeof process !== "undefined") {
  globalThis.jsdom = require("jsdom");
  globalThis.JSDOM = jsdom.JSDOM;
}

function parseDoc(input) {
  log('parseDoc: parsing input length', { len: input?.length });
  return new JSDOM(input).window.document;
}

function textToText(txt) {
  log('textToText: called');
  return parseDoc(txt).firstElementChild.textContent.trim();
}

async function fetchText() {
  try {
    log('fetchText: fetching', { url: arguments?.[0] });
    return await (await fetch(...arguments)).text();
  } catch (e) {
    log('fetchText: error', e?.message);
    return e.message;
  }
}

async function getDocText(url) {
  log('getDocText: fetching', { url });
  const rawDoc = await fetchText(url);
  const doc = parseDoc(rawDoc);
  [
    ...doc.querySelectorAll(
      'script,style,[aria-label="Contents"],[class*="reflist"],[class*="refbegin"],#search,[class*="language-list"]',
    ),
  ].forEach((x) => x.remove());
  return doc.firstElementChild.textContent;
}
async function getText(rawDoc) {
  const doc = parseDoc(rawDoc);
  [
    ...doc.querySelectorAll(
      'script,style,[aria-label="Contents"],[class*="reflist"],[class*="refbegin"],#search,[class*="language-list"]',
    ),
  ].forEach((x) => x.remove());
  return doc.firstElementChild.textContent;
}
//longest common subsequence. Used to find the closest matching trigram if no exact match is found.
globalThis.lcs = function lcs(seq1, seq2) {
  "use strict";
  let arr1 = [...(seq1 ?? [])];
  let arr2 = [...(seq2 ?? [])];
  if (arr2.length > arr1.length) {
    [arr1, arr2] = [arr2, arr1];
  }
  const dp = Array(arr1.length + 1)
    .fill(0)
    .map(() => Array(arr2.length + 1).fill(0));
  const dp_length = dp.length;
  for (let i = 1; i !== dp_length; ++i) {
    const dpi_length = dp[i].length;
    for (let x = 1; x !== dpi_length; ++x) {
      if (arr1[i - 1] === arr2[x - 1]) {
        dp[i][x] = dp[i - 1][x - 1] + 1;
      } else {
        dp[i][x] = Math.max(dp[i][x - 1], dp[i - 1][x]);
      }
    }
  }
  return dp[arr1.length][arr2.length];
};

const weightedLCS = (seq1, seq2) => {
  return (
    (lcs(seq1, seq2) * Math.min(seq1.length, seq2.length)) /
    Math.max(seq1.length, seq2.length,1)
  );
};

const stringify = (x) => {
  try {
    return JSON.parse(x);
  } catch {
    return String(x);
  }
};

//Count the number of of possible trigrams that follow a given trigram
const followCount = (model, key) => {
  if (!model[key]) return 0;
  return Object.keys(model[key]).length;
};

function getContextBoost(tokens, key) {
  const context = stringify(tokens.slice(-20));
  return lcs(context, key) / context.length / 20;
}

const actors =
  "Aragorn|Frodo|Gandalf|Legolas|Gimli|Boromir|Samwise|Merry|Pippin|Faramir|Denethor|Elrond|Galadriel|Saruman"
  .toLowerCase()
  .split("|");
const activeActors = {};

function getActorBoost(model, key) {
  if (!model[key]) return 0;
  let score = 0;
  const smk = stringify(model[key]).toLowerCase();
  for (const actor in activeActors) {
    if (smk.includes(actor)) {
      score += 0.2;
    }
    score += 0.2 * ((lcs(smk, actor) * actor.length) / smk.length);
  }
  return score;
}

//Get the next token in the sequence. This is the core of the model.
function getNextToken(keywords, trimodel, bimodel, tokens = []) {
  log('getNextToken: called', { keywords, tokensLength: tokens.length });
  const randoSkip = false; //Math.random() < 0.1;
  const strtok = stringify(tokens);
  let model = trimodel;
  let maxMatch = 0;
  let keyMatch = keywords;
  let matches = trimodel[keywords];
  let selectedModel = "trigram";
  // 10% chance to do fuzzy match search even if exact match is found.
  if (randoSkip || !matches) {
    selectedModel = "bigram";
    matches = bimodel[keywords.split(" ").pop()];
    if (randoSkip || !matches) {
      selectedModel = "lcs";
      for (const key in trimodel) {
        // lcs finds common sequences.
        // min length/max length punishes differences in length
        // strtok.split(key).length punishes repeated sequences
        const keylcs = weightedLCS(key, keywords) / Math.max(strtok.split(key).length,1);
        if (keylcs > maxMatch) {
          maxMatch = keylcs;
          keyMatch = key;
        }
      }
      matches = trimodel[keyMatch];
    } else {
      model = bimodel;
    }
  }
  maxMatch = 0;
  for (const key in matches) {
    //followCount boosts trigrams that have more possible followups
    //followCount is a hueristic inspired by Kneser–Ney smoothing but much simpler
    if (
      (matches[key] +
        getActorBoost(model, key) +
        getContextBoost(tokens, key) +
        followCount(model, key) * 0.01) /
      strtok.split(key).length >
      maxMatch
    ) {
      maxMatch = matches[key];
      keyMatch = key;
    }
  }
  let lk;
  try{
  keyMatch = String(keyMatch);
   lk = keyMatch.toLowerCase();
  }catch(e){
    console.warn(e,keywords,model[keywords],matches,keyMatch);
  }
  for (const actor of actors) {
    if (lk.includes(actor)) {
      activeActors[actor] = 20;
    }
  }
  for (const actor in activeActors) {
    activeActors[actor]--;
    if (activeActors[actor] <= 0) {
      delete activeActors[actor];
    }
  }
  if (/[A-Z]/.test(keyMatch) && !/\?|\.|\!/.test(keywords)) {
    activeActors[keyMatch] = 20;
  }
  delete activeActors["I"];
  log('getNextToken: selected', { keyMatch, selectedModel, randoSkip });
  return keyMatch;
}

const join = (x, y = "") => {
  try {
    return x.join(y);
  } catch {
    return String(y);
  }
};

function generate(prompt, trimodel, bimodel, context = []) {
  log('generate: called', { prompt, contextLength: context.length });
  if (!prompt) {
    prompt = context[context.length - 1];
  }
  const seed1 = getNextToken(prompt, trimodel, bimodel, context);
  const seed2 = getNextToken(`${prompt} ${seed1}`, trimodel, bimodel, context);
  const out = [seed1, seed2];
  context.push(seed1);
  context.push(seed2);
  const tokens = context;
  while (join(out).split(/[\.\?\!]/).length < 10) {
    const nextToken = getNextToken(
      `${tokens[tokens.length - 2]} ${tokens[tokens.length - 1]}`,
      trimodel,
      bimodel,
      tokens,
    );
    tokens.push(nextToken);
    out.push(nextToken);
  }
  const result = out
    .join(" ")
    .replace(/\? [a-z]/g, (x) => x.toUpperCase())
    .replace(/\. [a-z]/g, (x) => x.toUpperCase())
    .replace(/\! [a-z]/g, (x) => x.toUpperCase());
  log('generate: result length', result.length);
  return result;
}

if (typeof process) {
  const fsPromises = require("fs/promises");
  async function readFile(filePath) {
    try {
      return await fsPromises.readFile(filePath, {
        encoding: "utf8"
      });
    } catch (err) {
      return err.message;
    }
  }
  async function writeFile(filePath, content) {
      try {
        return await fsPromises.writeFile(filePath, content);
      } catch (err) {
        return err.message;
      }
    }
    (async () => {

     // let mvlines = await readFile("/Users/pa27161/Downloads/archive/movie_lines.txt");
      //mvlines = mvlines.split("\n").map(line => (line.split("+++$+++").pop())).join("\n");
      //await writeFile('../mvlines.txt', textToText(mvlines).replace(/\s+([\?\.\!,;:])/g, '$1'));
      //await writeFile('../mvlines.harper.txt', await processInBatches(await readFile("../mvlines.txt")));
      
      //await writeFile('hobbit-down.txt',(await readFile('hobbit.txt')).toLowerCase());
      log('main: starting file reads');
      let texts = (
        await Promise.all([
            //getText(await readFile("classified/eng.html")),
         // readFile("../mvlines.txt"),
         // readFile("../mvlines.harper.txt"),
         // readFile("../mvlines.strict.txt"),
          readFile("../tolkienizer/hobbit.txt"),
          readFile("../tolkienizer/fellowship.txt"),
          readFile("../tolkienizer/towers.txt"),
          readFile("../tolkienizer/king.txt"),
          //readFile("../tolkienizer/hobbit-fren.txt"),
         // readFile("../tolkienizer/fellowship-fren.txt"),
          //readFile("../tolkienizer/towers-fren.txt"),
         // readFile("../tolkienizer/king-fren.txt"),
          readFile("../tolkienizer/hobbit.strict.txt"),
          readFile("../tolkienizer/fellowship.strict.txt"),
          readFile("../tolkienizer/towers.strict.txt"),
          readFile("../tolkienizer/king.strict.txt"),
         // readFile("fellowship.txt"),
          //  readFile("fellowship-lan.txt"),
          //  readFile("fellowship-fren.txt"),
         // readFile("towers.txt"),
          //    readFile("towers-lan.txt"),
          //   readFile("towers-fren.txt"),
         // readFile("king.txt"),
          // readFile("king-lan.txt"),
          //   readFile("king-fren.txt"),
          //...Array(2).map(()=>readFile("hobbit.txt")),
          //readFile("hobbit.txt")
          //  readFile("hobbit-lan.txt"),
          // readFile("hobbit-fren.txt")
          // readFile("hobbit-afnlafen.txt"),
          /* (await readFile("pedia.txt"))
            .split("\n")
            .filter((x) => !/[^a-zA-Z0-9,\'\"\.\s\-:\(\)\!\?\—]/.test(x))
            .join("\n"),*/
          //getDocText("https://archive.org/stream/the-world-book-encyclopedia-volume-1-a/The%20World%20Book%20Encyclopedia%2C%20Volume%201%20A_djvu.txt")
          //getDocText("https://raw.githubusercontent.com/Phylliida/Dialogue-Datasets/refs/heads/master/MovieCorpus.txt")
          //silmarillion
          //getDocText("https://archive.org/stream/TheSilmarillionIllustratedJ.R.R.TolkienTedNasmith/The%20Silmarillion%20%28Illustrated%29%20-%20J.%20R.%20R.%20Tolkien%3B%20Ted%20Nasmith%3B_djvu.txt"),

          //narnia2
          //getDocText("https://archive.org/stream/LewisCSNarnia3TheHorseAndHisBoy/Lewis_C_S_-_Narnia_2_-_The_Lion_The_Witch_and_The__djvu.txt")

          /*
      //elfland
      getDocText("https://www.gutenberg.org/files/61077/61077-0.txt"),
      
      //beowulf
      getDocText("https://www.gutenberg.org/cache/epub/16328/pg16328.txt"),
      
      
      //modern beowulf
      getDocText("https://www.gutenberg.org/cache/epub/50742/pg50742.txt"),
      
      //The Kalevala

      getDocText("https://www.gutenberg.org/cache/epub/5186/pg5186.txt"),
      
      //fellowship movie script
      getDocText("https://imsdb.com/scripts/Lord-of-the-Rings-Fellowship-of-the-Ring,-The.html"),
      getDocText("https://imsdb.com/scripts/Lord-of-the-Rings-The-Two-Towers.html"),
      getDocText("https://imsdb.com/scripts/Lord-of-the-Rings-Return-of-the-King.html"),
      getDocText("https://pjhobbitfilms.fandom.com/wiki/The_Hobbit:_An_Unexpected_Journey/Transcript"),*/
          /*   (async () =>
          (
            await getDocText("https://www.gutenberg.org/cache/epub/10/pg10.txt")
          ).replaceAll("’", "'"))(),*/
        ])
      ).map(text => text
        .replace(/(\s|\\s|\\n)+/g, " ")
        .replace(/\s+,/g, ",")
        .replace(/\s+;/g, ";")
        .replace(/\s+\./g, ".")
        .replace(/\s+\!/g, "!")
        .replace(/\s+\?/g, "?")
        .replaceAll('¬', '').replaceAll('�',"'"));

      log('main: file reads complete', { files: texts.length });

      let texts2 = texts.map(text => text.replaceAll('-', ' ').replaceAll('—', ' ').replaceAll('�',"'"));
      let texts3 = texts.map(text => text.replaceAll('-', '').replaceAll('—', ''));
      let allTexts = texts.concat(texts2).concat(texts3);

      let allTrimodels = allTexts.map(text => buildNGrams(text)).concat(allTexts.map(text => buildPrunedNGrams(text)));

      let allBimodels = allTexts.map(text => buildNGrams(text, 2)).concat(allTexts.map(text => buildPrunedNGrams(text, 2)));

      let trimodel = pruneTopScores(mergeModels(...allTrimodels));
      log('main: trimodel built', { keys: Object.keys(trimodel).length });
      // trimodel = Object.fromEntries(Object.entries(trimodel).sort());
      let bimodel = pruneTopScores(mergeModels(...allBimodels));
      log('main: bimodel built', { keys: Object.keys(bimodel).length });
      // bimodel = Object.fromEntries(Object.entries(bimodel).sort());

      /*let text = allTexts.join(' ');
    let smodel = buildSGrams(text);

    let retrimodel = mergeModels(
      reverseBuildNGrams(text),
      reverseBuildPrunedNGrams(text),
    );
    retrimodel = Object.fromEntries(Object.entries(retrimodel).sort());
    let rebimodel = mergeModels(
      reverseBuildNGrams(text, 2),
      reverseBuildPrunedNGrams(text, 2),
    );
    rebimodel = Object.fromEntries(Object.entries(rebimodel).sort());
*/
      const fs = require("fs");
      const {
        execSync
      } = require("child_process");
      const save = '-tolkien-';
      fs.writeFileSync(
        `tri${save}model.json.txt`,
        JSON.stringify(trimodel)
      );
      log(`main: wrote tri${save}model.json.txt`);
      execSync(`gzip -k --force tri${save}model.json.txt`);
      /*
          fs.writeFileSync(
            "retrimodel.json.txt",
            JSON.stringify(retrimodel)
              .replaceAll('":{"', "[")
              .replaceAll('},"', "]")
              .replaceAll(',"', "¸")
              .replaceAll('":', "="),
          );
          execSync("gzip -k --force retrimodel.json.txt");
      */
      fs.writeFileSync(
        `bi${save}model.json.txt`,
        JSON.stringify(bimodel)
      );
      log(`main: wrote bi${save}model.json.txt`);
      execSync(`gzip -k --force bi${save}model.json.txt`);
      /*
          fs.writeFileSync(
            "rebimodel.json.txt",
            JSON.stringify(rebimodel)
              .replaceAll('":{"', "[")
              .replaceAll('},"', "]")
              .replaceAll(',"', "¸")
              .replaceAll('":', "="),
          );
          execSync("gzip -k --force rebimodel.json.txt");
      */
      /*
    fs.writeFileSync(
      "smodel.json.txt",
      JSON.stringify(smodel).replaceAll('","', "¸"),
    );
    execSync("gzip -k --force smodel.json.txt");
*/
      /*
    const sil = await getDocText(
      "https://archive.org/stream/TheSilmarillionIllustratedJ.R.R.TolkienTedNasmith/The%20Silmarillion%20%28Illustrated%29%20-%20J.%20R.%20R.%20Tolkien%3B%20Ted%20Nasmith%3B_djvu.txt",
    );
    fs.writeFileSync("sil.txt", sil);
*/
      let context = [];
      let prompt = ">Aragorn";
      log('main: prompt', prompt);
      log('main: sample generate', generate(prompt, trimodel, bimodel, context));
    })();
}

})();
