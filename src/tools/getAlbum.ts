import { z } from "zod";
import { getAlbum } from "../client/bandcampClient.js";
import { mapClientError } from "./errorMapping.js";
import { detailSlugHelp, jsonResult, MAX_SLUG_LENGTH, UNTRUSTED_TEXT_NOTE, type ToolTextResult } from "./shared.js";

const SLUG_HELP = detailSlugHelp(
  "album",
  "johncarpentermusic/album/cathedral",
  "a bandcamp_search, bandcamp_browse_tag or bandcamp_get_artist result"
);

export const getAlbumToolConfig = {
  description:
    "Get full detail for one Bandcamp album as JSON: title, artist, releaseDate, label, tags, description, price and the full tracklist. " +
    "priceText is the digital album's price (the minimum; buyers may pay more) and priceCurrency its ISO 4217 currency code, both null when no price is listed; " +
    "isNameYourPrice true means pay-what-you-want with a minimum of priceText. " +
    "Each tracks[].artist is that track's own artist, which on a compilation differs from the album artist; " +
    "tracks[].slug (null when Bandcamp lists no page for the track) can be passed to bandcamp_get_track. " +
    `Argument slug: ${SLUG_HELP} ` +
    UNTRUSTED_TEXT_NOTE,
  inputSchema: {
    slug: z.string().min(1).max(MAX_SLUG_LENGTH).describe(SLUG_HELP),
  },
};

export async function getAlbumToolHandler({ slug }: { slug: string }): Promise<ToolTextResult> {
  try {
    return jsonResult(await getAlbum(slug));
  } catch (err) {
    return mapClientError(err, `No album found for "${slug}".`);
  }
}
