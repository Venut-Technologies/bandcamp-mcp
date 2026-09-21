import type { z } from "zod";
import {
  AlbumSchema,
  ArtistSchema,
  TrackSchema,
  TrackDetailSchema,
  SearchResultSchema,
  MAX_DISCOGRAPHY_ENTRIES,
} from "./types.js";
import type { Album, Artist, DiscographyItem, SearchResult, Track, TrackDetail } from "./types.js";
import { sanitizeText } from "./sanitize.js";
import { urlToArtistSlug, detailSlugToString, urlToDetailSlug } from "./urlSafety.js";
import type { DetailSlug } from "./urlSafety.js";
import { BandcampShapeChangedError, NotFoundError } from "./errors.js";
import type { DiscographyEntry, JsonLdBlock } from "./pageDataExtractor.js";

const MAX_TAG_LENGTH = 100;
// Titles, names, labels and dates: attacker-controlled text on a self-publish
// platform, capped like any other outbound string.
const MAX_NAME_LENGTH = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getStringField(obj: unknown, key: string): string | null {
  if (isRecord(obj)) {
    const value = obj[key];
    return typeof value === "string" ? value : null;
  }
  return null;
}

function getNestedName(obj: unknown, key: string): string | null {
  return isRecord(obj) ? getStringField(obj[key], "name") : null;
}

// Every string that leaves the client goes through sanitizeText. A name that
// is left empty (blank, or only tags/invisible characters) is null.
function cleanName(value: string | null): string | null {
  return sanitizeText(value, MAX_NAME_LENGTH).text || null;
}

// Every Zod validation in this module fails closed as shape drift: a value
// that made it past the explicit checks but still doesn't fit the schema
// means Bandcamp's data changed, not that the item doesn't exist.
function parseOrShapeChanged<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BandcampShapeChangedError(
      `${what} failed schema validation — Bandcamp's data shape may have changed`,
      { cause: result.error }
    );
  }
  return result.data;
}

// Bandcamp's real captured JSON-LD (tests/fixtures/album-cathedral.html) emits
// track durations as "P00H05M13S" — a non-standard ISO-8601 duration missing
// the "T" time-designator — rather than the textbook "PT5M13S" form. Accept
// both by making the "T" optional.
function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^PT?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const [, h, m, s] = match;
  if (h === undefined && m === undefined && s === undefined) return null;
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

// Drift vs. absence for the page's `name`: the key must exist and hold a
// string or null. Missing or another type is drift; null/blank is handled by
// the caller as NotFound.
function requireNameKey(raw: JsonLdBlock, kind: "Album" | "Track"): void {
  if (!("name" in raw)) {
    throw new BandcampShapeChangedError(
      `${kind} JSON-LD has no "name" key — Bandcamp's page structure may have changed`
    );
  }
  if (raw.name !== null && typeof raw.name !== "string") {
    throw new BandcampShapeChangedError(
      `${kind} JSON-LD "name" is a ${typeof raw.name}, not a string — Bandcamp's page structure may have changed`
    );
  }
}

function requireArtistName(raw: JsonLdBlock, kind: "Album" | "Track"): string {
  const artistName = cleanName(getNestedName(raw, "byArtist"));
  if (!artistName) {
    throw new BandcampShapeChangedError(
      `${kind} JSON-LD has no "byArtist.name" — Bandcamp's page structure may have changed`
    );
  }
  return artistName;
}

function requireTrackList(raw: JsonLdBlock): unknown[] {
  if (!isRecord(raw.track)) {
    throw new BandcampShapeChangedError(
      `Album JSON-LD "track" is missing or not an object — Bandcamp's page structure may have changed`
    );
  }
  const list = raw.track.itemListElement;
  if (!Array.isArray(list)) {
    throw new BandcampShapeChangedError(
      `Album JSON-LD "track.itemListElement" is missing or not an array — Bandcamp's page structure may have changed`
    );
  }
  return list;
}

function getAdditionalPropertyValue(obj: unknown, propName: string): unknown {
  if (!isRecord(obj)) return undefined;
  const props = obj.additionalProperty;
  if (!Array.isArray(props)) return undefined;
  for (const prop of props) {
    if (isRecord(prop) && prop.name === propName) return prop.value;
  }
  return undefined;
}

// On the real fixture, the top-level JSON-LD has no `offers` field at all —
// each purchasable format (digital album, vinyl, CD, merch, bundle, ...) is a
// separate entry in `albumRelease[]`, each with its own `offers`. Only the
// entry whose `additionalProperty` marks it as the digital album
// (item_type "a") is the album's price; with no such entry there is no album
// price (a vinyl/merch/bundle price is never reported as the album price).
function findDigitalAlbumRelease(albumRelease: unknown[]): Record<string, unknown> | null {
  const digital = albumRelease.find((entry) => getAdditionalPropertyValue(entry, "item_type") === "a");
  return isRecord(digital) ? digital : null;
}

function toPrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string" && value.trim() !== "") return toPrice(Number(value));
  return null;
}

function toCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

interface AlbumOffer {
  price: number;
  currency: string | null;
  minPrice: number | null;
}

function readOffer(offer: unknown): AlbumOffer | null {
  if (!isRecord(offer)) return null;
  const price = toPrice(offer.price);
  if (price === null) return null;
  const spec = offer.priceSpecification;
  return {
    price,
    currency: toCurrency(offer.priceCurrency),
    minPrice: isRecord(spec) ? toPrice(spec.minPrice) : null,
  };
}

// The first offer carrying a valid price; price and currency always come from
// that same offer.
function firstValidOffer(offers: unknown): AlbumOffer | null {
  for (const offer of Array.isArray(offers) ? offers : [offers]) {
    const parsed = readOffer(offer);
    if (parsed) return parsed;
  }
  return null;
}

function findAlbumOffer(raw: JsonLdBlock): AlbumOffer | null {
  if (raw.offers) return firstValidOffer(raw.offers);
  if (!Array.isArray(raw.albumRelease)) return null;
  const digital = findDigitalAlbumRelease(raw.albumRelease);
  return digital ? firstValidOffer(digital.offers) : null;
}

// A name-your-price release has a zero minimum. On real pages both `price`
// and `priceSpecification.minPrice` are 0 then ("name your price"); a paid
// release — including Bandcamp's usual "$9 USD or more" — has
// price === minPrice > 0.
function isNameYourPrice(offer: AlbumOffer | null): boolean {
  return offer !== null && (offer.minPrice ?? offer.price) === 0;
}

// Quotes, brackets and periods are spelling noise between two renderings of
// the same name (`Bonnie "Prince" Billy`, `Shay.`, `[Kukangendai]`).
const CREDIT_NOISE_PATTERN = /["'‘’“”«»()[\]{}.]+/g;
// How Bandcamp pages join collaborators in one credit line.
const CREDIT_SEPARATOR_CHARS = /[/,&+×]+/g;
const CREDIT_SPLIT_PATTERN = /\s*(?:[/,&+×]+|\bvs\b|\baka\b|\band\b|\bwith\b)\s*/;
// Below this, a fragment is an initial or a stray particle whose appearance in
// the other name means nothing.
const MIN_CREDIT_PART_LENGTH = 3;

function normalizeCreditName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(CREDIT_NOISE_PATTERN, " ").replace(/\s+/g, " ").trim();
}

// " a b c ": separators flattened to spaces and the whole padded, so a part is
// only ever matched at space boundaries — "co" can never hit inside "cocteau",
// and a CJK part still matches because these pages space-delimit them.
function creditHaystack(normalized: string): string {
  return ` ${normalized.replace(CREDIT_SEPARATOR_CHARS, " ").replace(/\s+/g, " ").trim()} `;
}

function creditParts(normalized: string): string[] {
  return normalized
    .split(CREDIT_SPLIT_PATTERN)
    .map((part) => part.trim())
    .filter((part) => part.length >= MIN_CREDIT_PART_LENGTH);
}

function namesSameParty(publisherName: string, artistName: string): boolean {
  const publisher = normalizeCreditName(publisherName);
  const artist = normalizeCreditName(artistName);
  if (!publisher || !artist) return false;
  if (publisher === artist) return true;
  const publisherText = creditHaystack(publisher);
  const artistText = creditHaystack(artist);
  return (
    creditParts(publisher).some((part) => artistText.includes(` ${part} `)) ||
    creditParts(artist).some((part) => publisherText.includes(` ${part} `))
  );
}

// The record label lives at `albumRelease[n].recordLabel.name`. Top-level
// `publisher` is whoever owns the Bandcamp page: on a self-released album
// that's the artist (same `@id` as `byArtist`), so it only counts as the
// label when it is a different entity.
//
// The `@id` comparison alone fails open, because Bandcamp omits byArtist's
// `@id` for any multi-artist credit — a collaboration, a remix crediting the
// original artist, a soundtrack with several composers. On those, a
// self-released album reported its own artist as its label ("released on
// Mokhov"), which the model states as fact. So when neither `@id` settles it,
// the names are compared as well, and the fallback is suppressed when the
// page owner is one of the credited parties.
//
// Known residual: a page owner whose name shares nothing with the credit
// (gunpointgame/album/gunpoint-the-soundtrack, credited to three composers)
// is still reported as the label. Nothing on the page distinguishes a label
// account from an artist account there — recorded in README and
// docs/bandcamp-endpoints.md rather than guessed at.
function getAlbumLabel(raw: JsonLdBlock): string | null {
  if (Array.isArray(raw.albumRelease) && raw.albumRelease.length > 0) {
    const entry = findDigitalAlbumRelease(raw.albumRelease) ?? raw.albumRelease[0];
    const recordLabelName = cleanName(getNestedName(entry, "recordLabel"));
    if (recordLabelName) return recordLabelName;
  }
  const publisherName = cleanName(getNestedName(raw, "publisher"));
  if (!publisherName) return null;
  const publisherId = getStringField(raw.publisher, "@id");
  const artistId = getStringField(raw.byArtist, "@id");
  if (publisherId === artistId) return null;
  const artistName = cleanName(getNestedName(raw, "byArtist"));
  if (artistName !== null && namesSameParty(publisherName, artistName)) return null;
  return publisherName;
}

// A slug only comes from an allowlisted release URL; anything else is null,
// never an error.
function safeDetailSlug(url: unknown): DetailSlug | null {
  if (typeof url !== "string") return null;
  try {
    return urlToDetailSlug(url);
  } catch {
    return null;
  }
}

// ... and of the expected kind (an album result never carries a track slug).
function detailSlugFromUrl(url: unknown, expectedType: "album" | "track"): string | null {
  const slug = safeDetailSlug(url);
  return slug && slug.itemType === expectedType ? detailSlugToString(slug) : null;
}

function artistSlugFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return urlToArtistSlug(url);
  } catch {
    return null;
  }
}

// Decoded, stripped, capped, without empties, and deduped case-insensitively
// (live pages repeat tags); the first spelling wins.
function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = sanitizeText(raw, MAX_TAG_LENGTH).text;
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

export interface AlbumPageExtras {
  tags: string[];
  about: string | null;
  credits: string | null;
}

function normalizeTrackListEntry(entry: unknown, index: number, albumTitle: string, albumArtist: string): Track {
  const label = `Track ${index + 1} on album "${albumTitle}"`;
  if (!isRecord(entry)) {
    throw new BandcampShapeChangedError(`${label} is not an object — tracklist shape may have changed`);
  }
  const item = entry.item;
  const trackTitle = cleanName(getStringField(item, "name"));
  if (!isRecord(item) || !trackTitle) {
    throw new BandcampShapeChangedError(`${label} is missing a name — tracklist shape may have changed`);
  }
  return parseOrShapeChanged(
    TrackSchema,
    {
      title: trackTitle,
      artist: cleanName(getNestedName(item, "byArtist")) ?? albumArtist,
      position: typeof entry.position === "number" ? entry.position : index + 1,
      durationSeconds: parseIsoDuration(item.duration),
      slug: detailSlugFromUrl(item["@id"], "track"),
    },
    label
  );
}

// Checks run in a fixed order so drift is never reported as "not found":
// (1) `name` key missing / not string-or-null → shape changed;
// (2) `track` / `track.itemListElement` missing or wrong type → shape changed;
// (3) null/blank name (or one that sanitizes to nothing) or an empty
//     tracklist → NotFound (semantically empty);
// (4) no usable `byArtist.name` → shape changed;
// (5) a malformed track entry → shape changed;
// (6) any schema failure → shape changed.
export function normalizeAlbum(raw: JsonLdBlock, extras: AlbumPageExtras): Album {
  requireNameKey(raw, "Album");
  const trackList = requireTrackList(raw);
  const title = cleanName(raw.name as string | null);
  if (!title || trackList.length === 0) {
    throw new NotFoundError("Album page parsed but had no title or no tracks — treating as not found");
  }
  const artistName = requireArtistName(raw, "Album");
  const tracks = trackList.map((entry, index) => normalizeTrackListEntry(entry, index, title, artistName));
  const offer = findAlbumOffer(raw);

  return parseOrShapeChanged(
    AlbumSchema,
    {
      title,
      artist: artistName,
      releaseDate: cleanName(getStringField(raw, "datePublished")),
      tracks,
      tags: sanitizeTags(extras.tags),
      description: sanitizeText(getStringField(raw, "description") ?? extras.about),
      priceText: offer === null ? null : String(offer.price),
      priceCurrency: offer?.currency ?? null,
      isNameYourPrice: isNameYourPrice(offer),
      label: getAlbumLabel(raw),
    },
    `Album "${title}"`
  );
}

export interface TrackPageExtras {
  tags: string[];
  about: string | null;
}

// Ruling 16: album = inAlbum's name, slug from inAlbum's own @id; null only
// when inAlbum is absent (or has no usable name). Real shapes:
// - a track on an album (track-primeval.html): inAlbum has its own @id, the
//   album URL (.../album/cathedral) → { title, slug };
// - a standalone single (track-temple-sleeper.html): inAlbum has no @id,
//   repeats the track's own name and lists only the track's own "t" release
//   → { title: <track title>, slug: null }.
function trackAlbum(inAlbum: unknown): TrackDetail["album"] {
  if (!isRecord(inAlbum)) return null;
  const title = cleanName(getStringField(inAlbum, "name"));
  if (!title) return null;
  return { title, slug: detailSlugFromUrl(inAlbum["@id"], "album") };
}

// Same order as normalizeAlbum, minus the tracklist checks.
export function normalizeTrackDetail(raw: JsonLdBlock, extras: TrackPageExtras): TrackDetail {
  requireNameKey(raw, "Track");
  const title = cleanName(raw.name as string | null);
  if (!title) {
    throw new NotFoundError("Track page parsed but had no title — treating as not found");
  }
  const artistName = requireArtistName(raw, "Track");
  return parseOrShapeChanged(
    TrackDetailSchema,
    {
      title,
      artist: artistName,
      durationSeconds: parseIsoDuration(raw.duration),
      slug: detailSlugFromUrl(raw["@id"], "track"),
      album: trackAlbum(raw.inAlbum),
      tags: sanitizeTags(extras.tags),
      description: sanitizeText(getStringField(raw, "description") ?? extras.about),
    },
    `Track "${title}"`
  );
}

function resolveUrl(href: string | null, base: URL): URL | null {
  if (href === null) return null;
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

// Grid entries link to their release as found on the page: relative on a
// single artist's page ("/album/x"), absolute and cross-subdomain on a label's
// ("https://other.bandcamp.com/album/x?label=…&tab=music"). Each link is
// resolved against the page it came from and must pass the allowlist to get
// a slug; otherwise the entry is kept with slug null and type "album". The
// <li> entries and data-client-items are deduped by resolved release URL
// (query, hash and trailing slash ignored), first occurrence wins. Titles and
// artists stay raw here; normalizeArtist sanitizes them.
export function toDiscographyItems(entries: DiscographyEntry[], pageUrl: URL): DiscographyItem[] {
  const seen = new Set<string>();
  const items: DiscographyItem[] = [];
  for (const entry of entries) {
    const url = resolveUrl(entry.url, pageUrl);
    if (url) {
      const key = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const detail = url ? safeDetailSlug(url.href) : null;
    items.push({
      title: entry.title,
      slug: detail ? detailSlugToString(detail) : null,
      type: detail?.itemType ?? "album",
      artist: entry.artist,
    });
  }
  return items;
}

export interface ArtistPageExtras {
  discography: DiscographyItem[];
}

// Artist/label pages carry no JSON-LD, so these are the raw strings returned
// by extractArtistName/Location/Bio. Unlike JSON-LD values (already decoded by
// JSON.parse) they come straight out of HTML markup and can still hold
// entities/tags — every one goes through sanitizeText.
export interface ArtistPageFields {
  name: string | null;
  location: string | null;
  bio: string | null;
}

export function normalizeArtist(fields: ArtistPageFields, extras: ArtistPageExtras): Artist {
  const name = cleanName(fields.name);
  if (!name) {
    throw new NotFoundError("Artist page parsed but had no name — treating as not found");
  }
  // Discography titles/artists are scraped from markup too: decode/strip/cap
  // them and drop entries left with no title. The total counts what is left.
  const discography: DiscographyItem[] = [];
  for (const entry of extras.discography) {
    const title = cleanName(entry.title);
    if (title) discography.push({ ...entry, title, artist: cleanName(entry.artist) });
  }
  return parseOrShapeChanged(
    ArtistSchema,
    {
      name,
      location: cleanName(fields.location),
      bio: sanitizeText(fields.bio),
      discography: discography.slice(0, MAX_DISCOGRAPHY_ENTRIES),
      discographyTotal: discography.length,
      discographyTruncated: discography.length > MAX_DISCOGRAPHY_ENTRIES,
    },
    `Artist "${name}"`
  );
}

type EntryOutcome = SearchResult | "malformed" | "unsupported";

function searchResult(fields: SearchResult): SearchResult {
  return parseOrShapeChanged(SearchResultSchema, fields, `Result "${fields.name}"`);
}

// Shared by search and browse/discover: individual bad entries are dropped,
// but if the list is non-empty, nothing normalizes and at least one entry is
// malformed, the per-entry shape has drifted — fail closed instead of telling
// the user "no results". Malformed = not an object, no string type key, or a
// supported type with no usable name; a well-formed entry of an unsupported
// type (e.g. "f" for a fan) is skipped silently.
function normalizeResultList(
  list: unknown[],
  what: string,
  readEntry: (entry: unknown) => EntryOutcome
): SearchResult[] {
  const results: SearchResult[] = [];
  let malformed = 0;
  for (const entry of list) {
    const outcome = readEntry(entry);
    if (outcome === "malformed") malformed++;
    else if (outcome !== "unsupported") results.push(outcome);
  }
  if (results.length === 0 && malformed > 0) {
    throw new BandcampShapeChangedError(
      `${what}: none of ${list.length} entries could be read (${malformed} malformed) — Bandcamp's result shape may have changed`
    );
  }
  return results;
}

// Search entries (tests/fixtures/search-*.json): albums ("a") and tracks
// ("t") carry name, band_name and a full item_url_path; bands ("b") carry
// item_url_root (item_url_path is null) and is_label, which is the only thing
// telling a label from an artist.
const SEARCH_ITEM_TYPES = new Set(["a", "b", "t"]);

function readSearchEntry(entry: unknown): EntryOutcome {
  if (!isRecord(entry) || typeof entry.type !== "string") return "malformed";
  if (!SEARCH_ITEM_TYPES.has(entry.type)) return "unsupported";
  const name = cleanName(getStringField(entry, "name"));
  if (!name) return "malformed";
  if (entry.type === "b") {
    return searchResult({
      type: entry.is_label === true ? "label" : "artist",
      name,
      artist: null,
      slug: artistSlugFromUrl(entry.item_url_root),
    });
  }
  const type = entry.type === "a" ? "album" : "track";
  return searchResult({
    type,
    name,
    artist: cleanName(getStringField(entry, "band_name")),
    slug: detailSlugFromUrl(entry.item_url_path, type),
  });
}

export function normalizeSearchResults(raw: unknown): SearchResult[] {
  const auto = isRecord(raw) ? raw.auto : undefined;
  const results = isRecord(auto) ? auto.results : undefined;
  if (!Array.isArray(results)) {
    throw new BandcampShapeChangedError("Search response missing auto.results — Bandcamp's search API shape may have changed");
  }
  return normalizeResultList(results, "Search response", readSearchEntry);
}

export interface DiscoverPage {
  results: SearchResult[];
  nextCursor: string | null;
}

// discover_web items (tests/fixtures/browse-electronic-top.json): item_type,
// title, band_name, album_artist and item_url. On a label-hosted release
// band_name is the label and album_artist the actual artist.
const DISCOVER_ITEM_TYPES: Record<string, "album" | "track"> = { a: "album", t: "track" };

function readDiscoverEntry(entry: unknown): EntryOutcome {
  if (!isRecord(entry) || typeof entry.item_type !== "string") return "malformed";
  if (!Object.hasOwn(DISCOVER_ITEM_TYPES, entry.item_type)) return "unsupported";
  const type = DISCOVER_ITEM_TYPES[entry.item_type];
  const name = cleanName(getStringField(entry, "title"));
  if (!name) return "malformed";
  return searchResult({
    type,
    name,
    artist: cleanName(getStringField(entry, "album_artist")) ?? cleanName(getStringField(entry, "band_name")),
    slug: detailSlugFromUrl(entry.item_url, type),
  });
}

// Also the longest cursor bandcamp_browse_tag accepts back from the model.
export const MAX_CURSOR_LENGTH = 1000;

// The cursor is an opaque token (base64 on live pages) that the caller hands
// back verbatim for the next page; null on the last page. It must be present,
// and it must survive sanitizing unchanged, since a cleaned-up copy would no
// longer be the token Bandcamp issued.
function readCursor(raw: Record<string, unknown>): string | null {
  const cursor = raw.cursor;
  if (cursor === null) return null;
  if (typeof cursor === "string" && cursor !== "" && sanitizeText(cursor, MAX_CURSOR_LENGTH).text === cursor) {
    return cursor;
  }
  throw new BandcampShapeChangedError(
    "Browse/discover response has no usable cursor — Bandcamp's browse API shape may have changed"
  );
}

// A rejected request comes back as HTTP 200 with
// { "__api_special__": "exception", "error_type": ... } and no results, which
// this reports as shape drift like any other response without a results array.
export function normalizeDiscoverResults(raw: unknown): DiscoverPage {
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    throw new BandcampShapeChangedError(
      "Browse/discover response missing a results array — Bandcamp's browse API shape may have changed"
    );
  }
  return {
    results: normalizeResultList(raw.results, "Browse/discover response", readDiscoverEntry),
    nextCursor: readCursor(raw),
  };
}
