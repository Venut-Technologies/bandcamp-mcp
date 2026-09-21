// The single Bandcamp-facing data-access module: the five functions the tool
// layer calls. Network policy (timeouts, retries, pacing, redirect checks)
// lives in httpClient; extraction in pageDataExtractor; validation and
// sanitizing in normalize. Typed client errors (NotFoundError,
// BandcampShapeChangedError, BandcampChallengeError, BandcampUnavailableError)
// propagate unchanged. An invalid slug is rejected with a plain Error before
// any URL is built or fetched.
import { BandcampShapeChangedError } from "./errors.js";
import { fetchJson, fetchHtml } from "./httpClient.js";
import {
  assertArtistPage,
  extractAbout,
  extractArtistBio,
  extractArtistLocation,
  extractArtistName,
  extractCredits,
  extractDiscography,
  extractJsonLd,
  extractLandingRelease,
  extractTags,
} from "./pageDataExtractor.js";
import {
  normalizeAlbum,
  normalizeArtist,
  normalizeDiscoverResults,
  normalizeSearchResults,
  normalizeTrackDetail,
  toDiscographyItems,
} from "./normalize.js";
import type { DiscoverPage } from "./normalize.js";
export type { DiscoverPage } from "./normalize.js";
import { artistSlugToUrl, detailSlugToUrl, parseArtistSlug, parseDetailSlug } from "./urlSafety.js";
import type { Album, Artist, SearchResult, TrackDetail } from "./types.js";

const SEARCH_URL = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic";
const DISCOVER_URL = "https://bandcamp.com/api/discover/1/discover_web";

export type SearchType = "all" | "album" | "artist" | "track" | "label";

// Artists and labels share the band filter "b"; search() tells them apart
// afterwards by each result's type.
const SEARCH_FILTERS: Record<SearchType, string> = {
  all: "",
  album: "a",
  artist: "b",
  track: "t",
  label: "b",
};

export async function search(query: string, type: SearchType = "all"): Promise<SearchResult[]> {
  const raw = await fetchJson(SEARCH_URL, {
    method: "POST",
    body: { search_text: query, search_filter: SEARCH_FILTERS[type], full_page: true, fan_id: null },
  });
  const results = normalizeSearchResults(raw);
  return type === "all" ? results : results.filter((result) => result.type === type);
}

// `tag` is sent as given (the tool layer normalizes it to Bandcamp's slug
// form); null lists all releases. A cursor is only valid for the tag and sort
// it came from.
export async function browseTag(tag: string | null, sort: "top" | "new", cursor?: string): Promise<DiscoverPage> {
  const raw = await fetchJson(DISCOVER_URL, {
    method: "POST",
    body: {
      category_id: 0,
      tag_norm_names: tag ? [tag] : [],
      geoname_id: 0,
      slice: sort,
      time_facet_id: null,
      cursor: cursor ?? null,
      size: 20,
      include_result_types: ["a"],
    },
  });
  return normalizeDiscoverResults(raw);
}

export async function getAlbum(slug: string): Promise<Album> {
  const detail = parseDetailSlug(slug, "album");
  const html = await fetchHtml(detailSlugToUrl(detail).toString());
  return normalizeAlbum(extractJsonLd(html), {
    tags: extractTags(html),
    about: extractAbout(html),
    credits: extractCredits(html),
  });
}

// Any /track/ page: a track on an album or a standalone single.
export async function getTrack(slug: string): Promise<TrackDetail> {
  const detail = parseDetailSlug(slug, "track");
  const html = await fetchHtml(detailSlugToUrl(detail).toString());
  return normalizeTrackDetail(extractJsonLd(html), { tags: extractTags(html), about: extractAbout(html) });
}

// Fetches /music, not the root: about a third of artist roots redirect to a
// featured album, while /music is the release grid. An artist whose only
// release is an album is redirected even from /music; that album is then the
// whole discography. Artist pages have no JSON-LD, so assertArtistPage does
// the challenge/drift check.
//
// Fails closed on the discography: a page that is neither a readable release
// grid nor a release page, or a grid that lists releases none of which parse,
// is drift — never an artist "with no releases". Only a present grid that
// lists nothing yields an empty discography.
export async function getArtist(slug: string): Promise<Artist> {
  const artist = parseArtistSlug(slug);
  const pageUrl = new URL("/music", artistSlugToUrl(artist));
  const html = await fetchHtml(pageUrl.toString());
  assertArtistPage(html);
  const grid = extractDiscography(html);
  const landingRelease = grid.entries.length === 0 ? extractLandingRelease(html) : null;
  if (grid.entries.length === 0 && !landingRelease && (!grid.found || grid.itemCount > 0)) {
    throw new BandcampShapeChangedError(
      "Artist /music page has no readable #music-grid entries and no release JSON-LD — Bandcamp's page structure may have changed"
    );
  }
  return normalizeArtist(
    { name: extractArtistName(html), location: extractArtistLocation(html), bio: extractArtistBio(html) },
    { discography: toDiscographyItems(landingRelease ? [landingRelease] : grid.entries, pageUrl) }
  );
}
