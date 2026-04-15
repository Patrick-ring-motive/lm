  function log(...args) {
  console.log('[edits.js]', ...args);
}
  
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
        SpellCheck: true,
        SentenceCapitalization: true,
        LongSentences: true
    });
    config = await globalLinter.getLintConfig();
    await globalLinter.setLintConfig({
        ...config,
        SpellCheck: true,
        Matcher: false, 
        Correctness: true
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



      let mvlines = await readFile("../mvlines.txt");
      mvlines = mvlines.split("\n").map(x=>x.trim()).filter(Boolean).join("\n")
      await writeFile('../mvlines.txt', mvlines);
      await writeFile('../mvlines.strict.txt', (await processInBatches(mvlines)).split("\n").map(x=>x.trim()).filter(Boolean).join("\n"));
      mvlines = await readFile("../mvlines.harper.txt");
      mvlines = mvlines.split("\n").map(x=>x.trim()).filter(Boolean).join("\n")
      await writeFile('../mvlines.harper.txt', mvlines);
    })();