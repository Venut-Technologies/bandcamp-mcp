import { z } from "zod";
import { browseTag } from "../client/bandcampClient.js";
import { BandcampUnavailableError } from "../client/errors.js";
import { MAX_CURSOR_LENGTH } from "../client/normalize.js";
import { sanitizeText } from "../client/sanitize.js";
import { logDiagnostic, notFoundAsDrift } from "./errorMapping.js";
import { UNTRUSTED_TEXT_NOTE, errorResult, jsonResult, readOnlyBandcampTool, textResult, type ToolTextResult } from "./shared.js";

const MAX_TAG_LENGTH = 100;

export const browseTagToolConfig = {
  ...readOnlyBandcampTool("Browse Bandcamp by tag"),
  description:
    "Browse Bandcamp releases by genre tag, sorted by top or new. Omit tag for an unfiltered top/new listing across all of Bandcamp. " +
    "Returns JSON {results, nextCursor}: up to 20 results per page, each {type, name, artist, slug}; pass a result's slug to bandcamp_get_album. " +
    "A result with slug null (e.g. a release on a custom domain) cannot be looked up. " +
    "A result's artist is the credited album artist, which can differ from the label hosting the release. " +
    "For the next page call again with the same tag and sort plus cursor set to nextCursor; nextCursor null means there are no more pages. " +
    UNTRUSTED_TEXT_NOTE,
  inputSchema: {
    tag: z
      .string()
      .min(1)
      .max(MAX_TAG_LENGTH)
      .optional()
      .describe(
        'Bandcamp tag slug as in bandcamp.com/discover/<tag>, lowercase and hyphenated, e.g. "ambient", "hip-hop-rap", "drum-bass"; non-Latin scripts are allowed, e.g. "русский-рок". Omit for an unfiltered listing.'
      ),
    sort: z.enum(["top", "new"]).default("top"),
    cursor: z
      .string()
      .min(1)
      .max(MAX_CURSOR_LENGTH)
      .optional()
      .describe("nextCursor from a previous bandcamp_browse_tag call made with the SAME tag and sort; omit for the first page."),
  },
};

// Bandcamp's tag slug form: lowercase words joined by "-", in any script.
// Checked live 2026-09-19 against discover_web:
// - "Hip Hop" → hip-hop, "Drum & bass" → drum-bass, "R&B" → r-b ("&"
//   separates like any other symbol); a raw "Hip Hop" returns nothing;
// - accents fold on Latin letters only: "Français" → francais, but
//   "русский-рок" (1234 results) keeps its "й" ("русскии-рок": 0) and
//   "ボーカロイド" (57) its dakuten ("ホーカロイト": 0);
// - other scripts' combining marks belong to the word: "ลูกทุ่ง" has results,
//   "ล-กท-ง" none.
// Invisible characters are dropped rather than turned into separators, and a
// mark with no letter to sit on is dropped, so the slug (echoed back in the
// empty-page text) holds only visible letters, their marks, digits and "-".
// "" means the tag has no letters or digits.
function toTagSlug(tag: string): string {
  return tag
    .trim()
    .normalize("NFKD")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/([a-z])\p{M}+/giu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/(?<![\p{L}\p{M}])\p{M}+/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function emptyPageText(tagSlug: string | null, cursor: string | undefined): string {
  if (cursor !== undefined) return "No more results.";
  if (tagSlug === null) return "No releases found.";
  return `No releases found for tag "${tagSlug}". Check the tag slug (e.g. on bandcamp.com/discover).`;
}

export async function browseTagToolHandler({
  tag,
  sort,
  cursor,
}: {
  tag?: string;
  sort: "top" | "new";
  cursor?: string;
}): Promise<ToolTextResult> {
  // Only an omitted tag means the unfiltered listing: a supplied tag that
  // normalizes to nothing must not silently widen to all of Bandcamp.
  const tagSlug = tag === undefined ? null : toTagSlug(tag);
  if (tagSlug === "") {
    return errorResult(
      `Tag "${sanitizeText(tag, MAX_TAG_LENGTH).text}" has no letters or digits; ` +
        'pass a Bandcamp tag slug such as "ambient", or omit tag for an unfiltered listing.'
    );
  }
  try {
    const page = await browseTag(tagSlug, sort, cursor);
    // An empty page that still has a nextCursor is not the end: pass the
    // cursor on rather than report "nothing found".
    if (page.results.length === 0 && page.nextCursor === null) {
      return textResult(emptyPageText(tagSlug, cursor));
    }
    return jsonResult(page);
  } catch (err) {
    // Bandcamp answers a garbage cursor, or one issued for another tag/sort,
    // with HTTP 500 (verified live, docs/bandcamp-endpoints.md). Any other
    // failure after a cursor (a 429, a 503, a network error) is reported as
    // itself.
    if (cursor !== undefined && err instanceof BandcampUnavailableError && err.status === 500) {
      logDiagnostic(err);
      return errorResult(
        `Bandcamp could not serve this page (${err.message}). ` +
          "The cursor is probably invalid or from a call with a different tag or sort: " +
          "call bandcamp_browse_tag again without cursor to start from the first page."
      );
    }
    return notFoundAsDrift(err);
  }
}
