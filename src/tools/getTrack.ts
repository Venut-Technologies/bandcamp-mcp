import { z } from "zod";
import { getTrack } from "../client/bandcampClient.js";
import { mapClientError } from "./errorMapping.js";
import { MAX_SLUG_LENGTH, UNTRUSTED_TEXT_NOTE, detailSlugHelp, jsonResult, readOnlyBandcampTool, type ToolTextResult } from "./shared.js";

// bandcamp_browse_tag lists albums only, so it is not a source of track slugs.
const SLUG_HELP = detailSlugHelp(
  "track",
  "johncarpentermusic/track/primeval",
  "a bandcamp_search track result, a bandcamp_get_album tracks[].slug or a bandcamp_get_artist discography entry"
);

// Album tracks have pages of their own (verified live: a track on an album
// answers at /track/<item> with its own JSON-LD), so this resolves any track
// page, not only a standalone single.
export const getTrackToolConfig = {
  ...readOnlyBandcampTool("Get Bandcamp track"),
  description:
    "Get detail for one Bandcamp track page, either a standalone single or a track on an album. " +
    "Pass tracks[].slug from bandcamp_get_album or a track slug from bandcamp_search. " +
    "The result's album tells you which album it belongs to. For a whole tracklist use bandcamp_get_album. " +
    "Returns JSON {title, artist, durationSeconds, slug, album, tags, description}; album is {title, slug} or null if the page names none, " +
    "and on a standalone single it repeats the track's own title with slug null. " +
    `Argument slug: ${SLUG_HELP} ` +
    UNTRUSTED_TEXT_NOTE,
  inputSchema: {
    slug: z.string().min(1).max(MAX_SLUG_LENGTH).describe(SLUG_HELP),
  },
};

export async function getTrackToolHandler({ slug }: { slug: string }): Promise<ToolTextResult> {
  try {
    return jsonResult(await getTrack(slug));
  } catch (err) {
    return mapClientError(err, `No track found for "${slug}".`);
  }
}
