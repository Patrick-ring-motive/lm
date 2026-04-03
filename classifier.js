const {
  JSDOM
} = require("jsdom");
const {
  franc
} = require("franc");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Downloads a URL, extracts text from every <td> element,
 * groups them by detected language (ISO 639-3), and writes
 * one HTML file per language into `outDir`.
 *
 * @param {string} url       – page to fetch
 * @param {string} [outDir]  – output directory (default: ./classified)
 * @returns {Promise<Record<string, string[]>>} lang → texts map
 */
async function classifyTableCells(url, outDir = "./classified") {
  // 1. Download
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  // 2. Parse & extract <td> texts
  const dom = new JSDOM(html);
  const tds = [...dom.window.document.querySelectorAll("td")];
  const texts = tds
    .map((td) => td.textContent.trim())
    .filter((t) => t.length > 0);

  // 3. Group by language
  const grouped = {};
  for (const text of texts) {
    const lang = franc(text, {
      minLength: 3
    }) || "und";
    if (!grouped[lang]) grouped[lang] = [];
    grouped[lang].push(text);
  }

  // 4. Write one HTML file per language
  fs.mkdirSync(outDir, {
    recursive: true
  });

  for (const [lang, items] of Object.entries(grouped)) {
    const rows = items.map((t) => `    <tr><td>${escapeHtml(t)}</td></tr>`).join("\n");
    const file = path.join(outDir, `${lang}.html`);
    fs.writeFileSync(
      file,
      `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <title>Language: ${lang}</title>
  <style>
    table { border-collapse: collapse; width: 100%; }
    td    { border: 1px solid #ccc; padding: 6px 10px; }
  </style>
</head>
<body>
  <h1>${lang} — ${items.length} cell(s)</h1>
  <table>
${rows}
  </table>
</body>
</html>\n`,
      "utf-8"
    );
    console.log(`  ✔ ${file}  (${items.length} cells)`);
  }

  console.log(`\nDone – ${Object.keys(grouped).length} language(s) written to ${outDir}/`);
  return grouped;
}

function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// --- CLI usage ---
if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: node classifier.js <url> [outDir]");
    process.exit(1);
  }
  classifyTableCells(url, process.argv[3]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  classifyTableCells
};

//classifyTableCells('https://patrick-ring-motive.github.io/guanaco-llama2/guanaco_llama2.html');
