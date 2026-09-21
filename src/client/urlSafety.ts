export interface DetailSlug {
  artist: string;
  itemType: "album" | "track";
  item: string;
}

// The artist segment becomes a DNS label (`https://<artist>.bandcamp.com/`),
// so it keeps the stricter hostname form: no leading or trailing dash.
const SLUG_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// The item segment is only a path component, so `^[a-z0-9-]+$` is the whole
// requirement. Requiring it to start and end alphanumeric was stricter than
// that and rejected Bandcamp's real slugs: a non-Latin title is slugified
// by collapsing it to dashes, so live items are named `-`, `--4`, `--6`,
// `--19`. Measured over 346 live search results, the strict form rejected 186
// of them (e.g. 35/50 hits for "Остановиться"), making those releases
// unaddressable by get_album/get_track and emitting `slug: null` from search,
// get_artist and browse_tag. The dash forms are still safe here: `.`, `/`, `%`
// and every other traversal or encoding character remain excluded.
const ITEM_SLUG_SEGMENT_PATTERN = /^[a-z0-9-]+$/;

function isValidSlugSegment(segment: string): boolean {
  return SLUG_SEGMENT_PATTERN.test(segment);
}

function isValidItemSlugSegment(segment: string): boolean {
  return ITEM_SLUG_SEGMENT_PATTERN.test(segment);
}

export function parseArtistSlug(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!isValidSlugSegment(trimmed)) {
    throw new Error(`Invalid artist slug "${input}"`);
  }
  return trimmed;
}

export function parseDetailSlug(input: string, expectedType: "album" | "track"): DetailSlug {
  const parts = input.trim().toLowerCase().split("/");
  if (parts.length !== 3) {
    throw new Error(`Invalid Bandcamp slug "${input}" — expected "artist/${expectedType}/item-slug"`);
  }
  const [artist, itemType, item] = parts;
  if (!isValidSlugSegment(artist)) throw new Error(`Invalid artist slug segment "${artist}"`);
  if (itemType !== expectedType) throw new Error(`Expected a "${expectedType}" slug but got type "${itemType}"`);
  if (!isValidItemSlugSegment(item)) throw new Error(`Invalid item slug segment "${item}"`);
  return { artist, itemType: expectedType, item };
}

export function detailSlugToUrl(slug: DetailSlug): URL {
  return new URL(`https://${slug.artist}.bandcamp.com/${slug.itemType}/${slug.item}`);
}

export function artistSlugToUrl(artist: string): URL {
  return new URL(`https://${artist}.bandcamp.com/`);
}

export function detailSlugToString(slug: DetailSlug): string {
  return `${slug.artist}/${slug.itemType}/${slug.item}`;
}

export function assertSafeBandcampUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Malformed URL "${input}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsafe URL scheme in "${input}"`);
  }
  const hostname = url.hostname.toLowerCase();
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":") || hostname === "localhost";
  if (isIpLiteral) {
    throw new Error(`Refusing IP-literal/local host in "${input}"`);
  }
  if (hostname !== "bandcamp.com" && !hostname.endsWith(".bandcamp.com")) {
    throw new Error(`Refusing non-Bandcamp host "${hostname}"`);
  }
  return url;
}

export function urlToDetailSlug(input: string): DetailSlug | null {
  const url = assertSafeBandcampUrl(input);
  const host = url.hostname.toLowerCase();
  if (host === "bandcamp.com") return null;
  const artist = host.replace(/\.bandcamp\.com$/, "");
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [itemType, item] = segments;
  if (itemType !== "album" && itemType !== "track") return null;
  if (!isValidSlugSegment(artist) || !isValidItemSlugSegment(item)) return null;
  return { artist, itemType, item };
}

export function urlToArtistSlug(input: string): string | null {
  const url = assertSafeBandcampUrl(input);
  const host = url.hostname.toLowerCase();
  if (host === "bandcamp.com") return null;
  const artist = host.replace(/\.bandcamp\.com$/, "");
  return isValidSlugSegment(artist) ? artist : null;
}
