import { BandcampChallengeError, BandcampShapeChangedError, NotFoundError } from "./errors.js";
import { decodeEntities } from "./sanitize.js";

export type JsonLdBlock = Record<string, unknown>;

const JSON_LD_PATTERN = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i;
const CHALLENGE_MARKERS = ["Just a moment", "cf-browser-verification", 'id="challenge-running"'];

function looksLikeChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function extractJsonLd(html: string): JsonLdBlock {
  const match = html.match(JSON_LD_PATTERN);
  if (!match) {
    if (looksLikeChallenge(html)) {
      throw new BandcampChallengeError(
        "Page looks like a bot-challenge/interstitial page, not a Bandcamp release page"
      );
    }
    throw new BandcampShapeChangedError(
      "No application/ld+json block found — Bandcamp's page structure may have changed"
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    throw new BandcampShapeChangedError("application/ld+json block was present but not valid JSON", {
      cause: err,
    });
  }
  // Everything downstream reads the block as a keyed object; a null, scalar
  // or array root is drift, not a page to read fields from.
  if (!isJsonObject(parsed)) {
    throw new BandcampShapeChangedError(
      "application/ld+json block is not a JSON object — Bandcamp's page structure may have changed"
    );
  }
  return parsed;
}

function extractByClass(html: string, className: string): string[] {
  const pattern = new RegExp(`class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([^<]*)<`, "gi");
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const text = match[1].trim();
    if (text) results.push(text);
  }
  return results;
}

export function extractTags(html: string): string[] {
  return extractByClass(html, "tag");
}

function extractByClassBlock(html: string, className: string): string | null {
  const pattern = new RegExp(`class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</div>`, "i");
  const match = html.match(pattern);
  return match ? match[1].trim() : null;
}

export function extractAbout(html: string): string | null {
  return extractByClassBlock(html, "tralbum-about");
}

export function extractCredits(html: string): string | null {
  return extractByClassBlock(html, "tralbum-credits");
}

// Artist/label pages carry no `application/ld+json` block at all (verified
// against the real captured fixture, tests/fixtures/artist-sacredbones.html —
// `extractJsonLd` would throw BandcampShapeChangedError on every real call).
// Name and location instead live in a plain `<p id="band-name-location">`
// block:
//   <p id="band-name-location">
//     <span class="title">Sacred Bones Records</span>
//     <span class="location secondaryText">New York</span>
//   </p>
function extractBandNameLocationBlock(html: string): string | null {
  const match = html.match(/id=["']band-name-location["'][^>]*>([\s\S]*?)<\/p>/i);
  return match ? match[1] : null;
}

// Artist pages have no JSON-LD, so extractJsonLd's challenge/drift detection
// never runs on them — without this check, an interstitial or a markup change
// would surface as "no name" → NotFoundError. Call it before the extract*
// functions. An album page passes: it carries the same artist sidebar, and an
// artist root whose landing page is a release redirects to that album page.
const BAND_NAME_TITLE_PATTERN = /class=["'][^"']*\btitle\b[^"']*["'][^>]*>([^<]*)</i;

// A subdomain held by a fan account (or any profile with no releases) answers
// 200 with a placeholder page instead of an artist page: no
// #band-name-location, no #music-grid, no JSON-LD — just
// <div class="stub-page-content fan"> with a .bio-pic placeholder, an <h1>
// name and a "Follow to get notified" line. That is semantically empty
// content (NotFoundError), not shape drift. Such a subdomain is reachable
// straight from bandcamp_search — a fan profile comes back as a type "b"
// entry indistinguishable from an artist — and from guessing a subdomain off
// a display name, so without this branch a normal drill-down tells the user
// Bandcamp's format changed and invites a bug report. Verified live
// 2026-09-20 on lo-fi-high and metallica; the marker is absent from every
// real artist/label/album/track page checked and from all other committed
// fixtures.
const STUB_PAGE_PATTERN = /class=["'][^"']*\bstub-page-content\b/i;

// A 200 page with no #band-name-location has three readings, checked in this
// order: a bot-challenge interstitial, a fan/placeholder stub profile, and —
// only when it is neither — genuine shape drift, so unrecognised markup still
// fails closed. The block without its .title element is drift inside the
// block; an empty .title is a page with no name, which normalizeArtist
// reports as not found.
export function assertArtistPage(html: string): void {
  const block = extractBandNameLocationBlock(html);
  if (block === null) {
    if (looksLikeChallenge(html)) {
      throw new BandcampChallengeError(
        "Page looks like a bot-challenge/interstitial page, not a Bandcamp artist page"
      );
    }
    // Matched on `stub-page-content` alone, not on the ` fan` modifier: any
    // stub variant has no #band-name-location, no #music-grid and no JSON-LD,
    // so there is nothing to return either way and "not found" is the better
    // classification for all of them.
    if (STUB_PAGE_PATTERN.test(html)) {
      throw new NotFoundError(
        "this Bandcamp subdomain is a fan or placeholder profile with no releases, not an artist or label page"
      );
    }
    throw new BandcampShapeChangedError(
      "No #band-name-location block found on the artist page — Bandcamp's page structure may have changed"
    );
  }
  if (!BAND_NAME_TITLE_PATTERN.test(block)) {
    throw new BandcampShapeChangedError(
      "#band-name-location has no .title element — Bandcamp's page structure may have changed"
    );
  }
}

export function extractArtistName(html: string): string | null {
  const block = extractBandNameLocationBlock(html);
  if (!block) return null;
  const match = block.match(BAND_NAME_TITLE_PATTERN);
  const text = match ? match[1].trim() : "";
  return text || null;
}

export function extractArtistLocation(html: string): string | null {
  const block = extractBandNameLocationBlock(html);
  if (!block) return null;
  const match = block.match(/class=["'][^"']*\blocation\b[^"']*["'][^>]*>([^<]*)</i);
  const text = match ? match[1].trim() : "";
  return text || null;
}

// `#bio-container`'s `data-bind="css: {'ko-ready': $data}"` attribute looks
// like it means the bio is only populated client-side via knockout.js, but
// verified against the real fixture that's not the case for the bio text
// itself: `data-bind` there only toggles a CSS class on the container. The
// actual bio is plain server-rendered markup nested inside it:
//   <div class="signed-out-artists-bio-text"><p id="bio-text">A Family Affair</p></div>
// A longer bio (verified on live pages) nests an overflow
// `<span class="peekaboo-text">` plus a trailing "... more" toggle
// `<span class="peekaboo-link">`, and uses <br> for line breaks. The toggle is
// UI chrome and is cut off; the rest is rendered the way a browser would
// (source whitespace collapsed, <br> → newline). The element is matched up
// to its own closing tag (a <p> today); if that is missing, it counts as
// absent rather than running into whatever </p> comes next. Remaining tags
// are stripped here, while every raw '<' is still a real tag (a user-typed
// '<' arrives as &lt;). Only entities are left for sanitizeText, which decodes them once and
// strips only real tag shapes — defence in depth, so a decoded &lt; can never
// pair with a real tag's '>' and swallow the text between them.
function extractBioTextMarkup(html: string): string | null {
  const match = html.match(/<(\w+)[^>]*\bid=["']bio-text["'][^>]*>([\s\S]*?)<\/\1\s*>/i);
  if (!match) return null;
  const text = match[2]
    .replace(/<span[^>]*\bpeekaboo-link\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/\s*<br\s*\/?>\s*/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .trim();
  return text || null;
}

// Fallback for a page where #bio-text is missing: the always server-rendered
// <meta name="description"> tag, which reads "\n{name}.\n{location}.\n{bio}\n".
// The name/location preamble is dropped when it matches the page's own
// #band-name-location values, so an artist with no bio (e.g. a label page
// whose meta is only the preamble) yields null rather than a fake bio. If the
// preamble can't be matched, the whole text is kept — a lesser-evil fallback.
// The meta encodes entities twice ("Rock &amp;amp; Roll") where
// #band-name-location encodes them once, so both sides are fully decoded
// before comparing (comparison only — the returned text is left as is).
function fullyDecode(text: string): string {
  let current = text;
  for (let i = 0; i < 5; i++) {
    const next = decodeEntities(current);
    if (next === current) break;
    current = next;
  }
  return current.trim();
}

function isPreambleLine(line: string | undefined, value: string | null): boolean {
  return value !== null && line !== undefined && fullyDecode(line) === `${fullyDecode(value)}.`;
}

function extractMetaDescriptionBio(html: string): string | null {
  const match = html.match(/<meta[^>]*name=["']description["'][^>]*content=(["'])([\s\S]*?)\1/i);
  if (!match) return null;
  const lines = match[2].trim().split("\n");
  if (isPreambleLine(lines[0], extractArtistName(html))) lines.shift();
  if (isPreambleLine(lines[0], extractArtistLocation(html))) lines.shift();
  const text = lines.join("\n").trim();
  return text || null;
}

export function extractArtistBio(html: string): string | null {
  return extractBioTextMarkup(html) ?? extractMetaDescriptionBio(html);
}

export interface DiscographyEntry {
  // Raw title/artist: <li> markup still has its entities; client items are
  // already-decoded JSON strings. Both go through sanitizeText downstream.
  title: string;
  // Entity-decoded link as found on the page, often relative ("/album/x").
  url: string | null;
  // The release's credited artist when the page gives one: a grid entry's
  // "artist-override" or client-item artist (a label's roster, a
  // collaboration), or a landing release's byArtist. Null means the page's
  // own artist.
  artist: string | null;
}

// `#music-grid` is an <ol> whose first 16 releases are rendered as
// <li class="music-grid-item"> entries:
//   <li ...><a href="/album/x">…<p class="title">Name<br>
//     <span class="artist-override">Other Artist</span></p></a></li>
// The rest of the catalog is only in the grid's data-client-items attribute,
// an entity-encoded JSON array of { title, page_url, type, artist? } that the
// page renders client-side (verified 2026-09-19: tests/fixtures/
// artist-sacredbones.html has 16 <li> + 384 items, a single artist's /music
// page 16 + 10, with no overlap). `\sid=` keeps a `data-id` from matching.
const MUSIC_GRID_PATTERN = /<(ol|ul)\b([^>]*\sid=["']music-grid["'][^>]*)>([\s\S]*?)<\/\1\s*>/i;
const GRID_ITEM_PATTERN = /<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi;
const GRID_ITEM_HREF_PATTERN = /<a\b[^>]*\shref=["']([^"']*)["']/i;
const GRID_ITEM_TITLE_PATTERN = /<p\b[^>]*\sclass=["'][^"']*\btitle\b[^"']*["'][^>]*>([^<]*)/i;
const GRID_ITEM_ARTIST_PATTERN = /\sclass=["'][^"']*\bartist-override\b[^"']*["'][^>]*>([^<]*)/i;
const CLIENT_ITEMS_PATTERN = /\sdata-client-items=(["'])([\s\S]*?)\1/i;

function gridItemEntry(itemHtml: string): DiscographyEntry | null {
  const title = itemHtml.match(GRID_ITEM_TITLE_PATTERN)?.[1].trim();
  if (!title) return null;
  const href = itemHtml.match(GRID_ITEM_HREF_PATTERN)?.[1].trim();
  const artist = itemHtml.match(GRID_ITEM_ARTIST_PATTERN)?.[1].trim();
  return { title, url: href ? decodeEntities(href) : null, artist: artist || null };
}

// Supplementary: a missing or malformed attribute (or entry) is skipped,
// never an error — the <li> entries still stand. `count` is the length of a
// parseable items array, readable entries or not.
function clientItemEntries(gridAttributes: string): { count: number; entries: DiscographyEntry[] } {
  const none = { count: 0, entries: [] };
  const attr = gridAttributes.match(CLIENT_ITEMS_PATTERN);
  if (!attr) return none;
  let items: unknown;
  try {
    items = JSON.parse(decodeEntities(attr[2]));
  } catch {
    return none;
  }
  if (!Array.isArray(items)) return none;
  const entries: DiscographyEntry[] = [];
  for (const item of items) {
    if (!isJsonObject(item) || typeof item.title !== "string") continue;
    entries.push({
      title: item.title,
      url: typeof item.page_url === "string" ? item.page_url : null,
      artist: typeof item.artist === "string" ? item.artist : null,
    });
  }
  return { count: items.length, entries };
}

export interface MusicGrid {
  // #music-grid is on the page.
  found: boolean;
  // Releases the grid lists, readable or not: its <li> elements plus the
  // entries of a parseable data-client-items array. Lets the caller tell a
  // genuinely empty grid (0) from a grid whose entries no longer parse.
  itemCount: number;
  // The releases that could be read: <li> entries first, then the client
  // items (grid order).
  entries: DiscographyEntry[];
}

// No #music-grid means no entries: the page is not a release grid (e.g. an
// artist whose /music redirects to their only album), and scanning the whole
// page would pick up unrelated links. Deduplication happens once URLs are
// resolved (toDiscographyItems in normalize.ts). Whether an empty result is
// drift is the caller's call (getArtist fails closed).
export function extractDiscography(html: string): MusicGrid {
  const grid = html.match(MUSIC_GRID_PATTERN);
  if (!grid) return { found: false, itemCount: 0, entries: [] };
  const entries: DiscographyEntry[] = [];
  let listItems = 0;
  for (const item of grid[3].matchAll(GRID_ITEM_PATTERN)) {
    listItems++;
    const entry = gridItemEntry(item[1]);
    if (entry) entries.push(entry);
  }
  const clientItems = clientItemEntries(grid[2]);
  return {
    found: true,
    itemCount: listItems + clientItems.count,
    entries: [...entries, ...clientItems.entries],
  };
}

const RELEASE_TYPES = new Set(["MusicAlbum", "MusicRecording"]);

// An artist whose only release is an album answers /music with a 303 to that
// album page (seen live 2026-09-19: demo--music → /album/instruments-of-labour;
// tests/fixtures/artist-landing-album.html). The page has no #music-grid, but
// its JSON-LD names the release, which is then the whole discography. Returns
// null for anything that is not a release page with a name and an @id.
export function extractLandingRelease(html: string): DiscographyEntry | null {
  const match = html.match(JSON_LD_PATTERN);
  if (!match) return null;
  let ld: unknown;
  try {
    ld = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!isJsonObject(ld) || typeof ld["@type"] !== "string" || !RELEASE_TYPES.has(ld["@type"])) return null;
  const url = ld["@id"];
  const title = ld.name;
  if (typeof url !== "string" || typeof title !== "string") return null;
  const byArtist = ld.byArtist;
  const artist = isJsonObject(byArtist) && typeof byArtist.name === "string" ? byArtist.name : null;
  return { title, url, artist };
}
