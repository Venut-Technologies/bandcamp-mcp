// Redaction is the first of three things that stand between a captured page
// and a committed fixture; the other two — trimming the page to parser input
// and replacing real identities and prose with invented ones — are manual and
// described in capture-fixture.ts.
//
// Album/track pages embed signed URLs of two kinds, and committed fixtures
// must carry neither, so every captured body goes through redactStreamUrls
// before it is written:
//
//  * playable mp3 streams — `*.bcbits.com/stream/...` in the `data-tralbum`
//    player attribute (and in discover_web's `featured_track.stream_url`), and
//    signed `bandcamp.com/stream_redirect?...` links in the recommendation
//    tiles' `data-audiourl` attributes;
//  * download grants — `bandcamp.com/download?fsig=...` in `data-tralbum`'s
//    `freeDownloadPage` (free/name-your-price releases), and the
//    `*.bandcamp.com/download/album|track?...&fsig=...` per-format links that
//    such a download page itself serves. The signature stays valid for days,
//    so a committed capture would be a working purchase-bypass link in the
//    public repository and in its git history.
//
// Inside an HTML attribute the player JSON is entity-encoded
// (`{&quot;mp3-128&quot;:&quot;https://t4.bcbits.com/stream/…&amp;token=…&quot;}`),
// so a URL ends at an encoded quote as well as at a raw quote, whitespace or
// angle bracket. The host and path prefix are matched exactly, so a match can
// never start at an unrelated URL earlier in the same attribute and swallow
// the JSON in between. JSON-escaped slashes (`https:\/\/…\/stream\/…`) and
// scheme-relative URLs (`//t4.bcbits.com/stream/…`) are matched too.
const STREAM_URL_PATTERN =
  /(?:https?:)?(?:\\?\/){2}(?:(?:[a-z0-9-]+\.)*bcbits\.com\\?\/stream\\?\/|(?:[a-z0-9-]+\.)*bandcamp\.com\\?\/(?:stream_redirect\b|download\\?\/?(?:album|track)?\b))(?:(?!&quot;|&#34;|&#x22;)[^"'\s<>])*/gi;

export const STREAM_URL_REPLACEMENT = "REDACTED-STREAM-URL";

// Any trace of a signed stream or download URL, in either slash form. The bare
// `fsig=` arm is the durable guard: it fails closed on a future signed shape
// this module's pattern does not know how to clean, whatever its host or path.
export const STREAM_URL_MARKER =
  /bcbits\.com\\?\/stream|bandcamp\.com\\?\/stream_redirect|bandcamp\.com\\?\/download|fsig=/i;

export function redactStreamUrls(text: string): string {
  return text.replace(STREAM_URL_PATTERN, STREAM_URL_REPLACEMENT);
}
