#!/usr/bin/env node
// Usage:
//   npx tsx scripts/capture-fixture.ts <url> <output-path>
//   npx tsx scripts/capture-fixture.ts <url> <output-path> --json-body '<json>'
//
// Signed stream and download URLs are redacted before the body is written
// (see redact-stream-urls.ts), so a fixture is not byte-identical to the
// response.
//
// A captured page is NOT ready to commit. Two manual steps follow, because
// what this repository publishes is parser input, not someone's release page:
//
//   1. Trim it to the markup the parsers read — the JSON-LD block, the tag
//      links, #band-name-location, #bio-text, #music-grid (its <li> entries
//      and the data-client-items attribute, itself reduced to title, page_url
//      and artist), .tralbum-about and .tralbum-credits. Scripts, styles,
//      navigation, footers, recommendation tiles and tracking blobs go.
//   2. Replace the identities and the prose: artist, label, album and track
//      names, subdomains and item slugs become invented but plausible ones,
//      used consistently across every fixture and test, and bios, descriptions,
//      about and credits text are rewritten as short invented sentences.
//      tests/fixtures.test.ts fails if a long description survives.
//
// Prices, dates and the shape of everything stay as captured: they are what
// the parsers are tested against.
import { writeFileSync } from "node:fs";
import { VERSION } from "../src/version.js";
import { redactStreamUrls } from "./redact-stream-urls.js";

const [, , url, outputPath, flag, jsonBody] = process.argv;

if (!url || !outputPath) {
  console.error("Usage: capture-fixture.ts <url> <output-path> [--json-body '<json>']");
  process.exit(1);
}

const headers: Record<string, string> = {
  "User-Agent": `Mozilla/5.0 (compatible; bandcamp-mcp/${VERSION}; +https://github.com/Venut-Technologies/bandcamp-mcp)`,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

const init: RequestInit = { headers };
if (flag === "--json-body" && jsonBody) {
  init.method = "POST";
  headers["Content-Type"] = "application/json";
  init.body = jsonBody;
}

const response = await fetch(url, init);
const text = redactStreamUrls(await response.text());
writeFileSync(outputPath, text);
console.log(`Saved ${outputPath} (status ${response.status}, ${text.length} bytes, stream URLs redacted)`);
