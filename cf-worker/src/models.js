// models.js — Fetch, decompress, and cache n-gram model dictionaries.
// Models are held in module-level variables so they survive across requests
// within the same CF Worker isolate (warm starts).

/** @typedef {import("./engine.js").Models} Models */

let cached = null;

/**
 * Fetch a gzip-compressed JSON model from a remote URL and decompress it.
 * @param {string} url  Absolute URL to a `.gz` JSON file.
 * @returns {Promise<Record<string,Record<string,number>>>}
 */
async function fetchGzipJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch model ${url}: ${response.status}`);
  }

  const decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(decompressed).text());
}

/**
 * Load both models. Results are cached in module scope so subsequent
 * requests in the same isolate skip the network round-trip.
 *
 * @param {string} baseUrl  URL prefix (no trailing slash) where
 *   `trimodel.json.txt.gz` and `bimodel.json.txt.gz` live.
 * @returns {Promise<Models>}
 */
export async function loadModels(baseUrl) {
  if (cached) return cached;

  const [trimodel, bimodel] = await Promise.all([
    fetchGzipJson(`${baseUrl}/trimodel.json.txt.gz`),
    fetchGzipJson(`${baseUrl}/bimodel.json.txt.gz`),
  ]);

  cached = {
    trimodel,
    bimodel,
    trimodelKeys: Object.keys(trimodel),
  };

  return cached;
}
