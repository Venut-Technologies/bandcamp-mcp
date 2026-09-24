import { z } from "zod";
import { search, type SearchType } from "../client/bandcampClient.js";
import { sanitizeText } from "../client/sanitize.js";
import { notFoundAsDrift } from "./errorMapping.js";
import { UNTRUSTED_TEXT_NOTE, jsonResult, readOnlyBandcampTool, textResult, type ToolTextResult } from "./shared.js";

const MAX_QUERY_LENGTH = 200;

export const searchToolConfig = {
  ...readOnlyBandcampTool("Search Bandcamp"),
  description:
    "Search Bandcamp for albums, artists, tracks, or labels. Returns a ranked JSON list of matches, each {type, name, artist, slug}. " +
    "A result's slug is what you pass on: an album's to bandcamp_get_album, a track's to bandcamp_get_track, an artist's or label's to bandcamp_get_artist. " +
    "It is a Bandcamp URL slug, not a display name; a result with slug null (e.g. an artist on a custom domain) cannot be looked up. " +
    'type "artist" and type "label" are told apart by Bandcamp\'s is_label flag on each result. ' +
    UNTRUSTED_TEXT_NOTE,
  inputSchema: {
    query: z.string().trim().min(1).max(MAX_QUERY_LENGTH).describe("Free-text search query, e.g. an artist or album name"),
    type: z
      .enum(["all", "album", "artist", "track", "label"])
      .default("all")
      .describe("Restrict results to one result type"),
  },
};

export async function searchToolHandler({ query, type }: { query: string; type: SearchType }): Promise<ToolTextResult> {
  try {
    const results = await search(query, type);
    if (results.length === 0) {
      // The query is echoed back to the model, so it gets the same cleaning
      // as any other outbound text.
      const echoed = sanitizeText(query, MAX_QUERY_LENGTH).text;
      return textResult(
        type === "all"
          ? `No results found for "${echoed}".`
          : `No ${type} results found for "${echoed}" (try type "all").`
      );
    }
    return jsonResult(results);
  } catch (err) {
    return notFoundAsDrift(err);
  }
}
