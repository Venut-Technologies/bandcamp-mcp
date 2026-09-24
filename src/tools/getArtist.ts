import { z } from "zod";
import { getArtist } from "../client/bandcampClient.js";
import { mapClientError } from "./errorMapping.js";
import { MAX_SLUG_LENGTH, UNTRUSTED_TEXT_NOTE, jsonResult, readOnlyBandcampTool, type ToolTextResult } from "./shared.js";

// Used in both the description and the slug's .describe().
const SLUG_HELP =
  'Bandcamp subdomain slug such as "sacredbonesrecords", copied from a bandcamp_search artist or label result. ' +
  'The first segment of any album or track slug also works ("johncarpentermusic" from "johncarpentermusic/album/cathedral"), ' +
  "and so does the subdomain of a https://<subdomain>.bandcamp.com/ URL. It is never a display name.";

export const getArtistToolConfig = {
  ...readOnlyBandcampTool("Get Bandcamp artist or label"),
  description:
    "Get detail for one Bandcamp artist or label as JSON: name, location, bio and discography. " +
    "Each discography entry is {title, slug, type, artist}: pass an album's slug to bandcamp_get_album and a track's to bandcamp_get_track. " +
    "An entry with slug null (e.g. a release on a custom domain) cannot be looked up. " +
    "On a label, an entry's artist names the release's actual artist; null means the page's own artist. " +
    "Only the first 100 releases are listed: discographyTruncated is true when there are more, and discographyTotal counts them all. " +
    "Artist and label pages carry no tags; use bandcamp_get_album for a release's tags. " +
    "Artists on a custom domain (not *.bandcamp.com) can't be fetched. " +
    `Argument slug: ${SLUG_HELP} ` +
    UNTRUSTED_TEXT_NOTE,
  inputSchema: {
    slug: z.string().min(1).max(MAX_SLUG_LENGTH).describe(SLUG_HELP),
  },
};

export async function getArtistToolHandler({ slug }: { slug: string }): Promise<ToolTextResult> {
  try {
    return jsonResult(await getArtist(slug));
  } catch (err) {
    return mapClientError(err, `No artist found for "${slug}".`);
  }
}
