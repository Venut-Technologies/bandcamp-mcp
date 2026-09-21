# Bandcamp endpoint reference notes

Verified 2026-08-22 against thyoondev/bandcamp-mcp (src/bandcamp_client.py),
a working open-source reference implementation, plus live requests to real
Bandcamp pages. Treat every field name below as "verify against a captured
fixture before trusting it" — Bandcamp does not publish or version these.

Base URL: `https://bandcamp.com`

## Search

`POST https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic`

Body:
```json
{ "search_text": "carpenter", "search_filter": "", "full_page": true, "fan_id": null }
```

`search_filter` values: all=`""`, album=`"a"`, artist=`"b"`, track=`"t"`, label=`"b"`.

Response shape, verified against `search-carpenter.json` (filter `"a"`),
`search-sacred-bones-bands.json` (`"b"`) and `search-primeval-tracks.json`
(`"t"`), 2026-09-19: `{ "auto": { "results": [...], ... }, "tag", "genre" }`,
at most 50 results.

- album (`"a"`) / track (`"t"`): `name`, `band_name`, `item_url_path` (the
  full release URL, e.g. `https://carpenterbrut.bandcamp.com/album/trilogy`),
  `item_url_root`; tracks also `album_name`. → `{ type, name, artist:
  band_name, slug }`, where the slug must be of the result's own kind.
- band (`"b"`): `name`, `item_url_root` (e.g.
  `https://sacredbonesrecords.bandcamp.com`), `item_url_path: null`,
  `location`, and `is_label`: the only field that separates labels from
  artists. `is_label: true` → `type: "label"`, else `"artist"`; the slug is
  the subdomain, and `artist` is null.
- Artists and labels share filter `"b"`, so `search(q, "artist" | "label")`
  keeps only results of that type after normalizing.
- Releases on an artist's custom domain (e.g.
  `https://ilistentojohn.com/album/fairy-tales-forgotten` in
  `search-carpenter.json`) fail the allowlist and get `slug: null`.
- A well-formed entry of another type (e.g. a fan) is skipped.

## Browse / discover (backs `bandcamp_browse_tag`)

`POST https://bandcamp.com/api/discover/1/discover_web`

Body:
```json
{
  "category_id": 0,
  "tag_norm_names": ["electronic"],
  "geoname_id": 0,
  "slice": "top",
  "time_facet_id": null,
  "cursor": null,
  "size": 20,
  "include_result_types": ["a"]
}
```

`category_id`: all=0, digital=1, vinyl=2, cd=3, cassette=4 (v1 always uses 0).
`slice`: `"top"` | `"new"` | `"rec"` (`"rec"` needs a logged-in fan session — v1
only exposes `top`/`new`, per the design spec's `discover`→`browse_tag` fold-in).
`tag_norm_names`: empty array for an unfiltered listing.

Response shape, verified against `browse-electronic-top.json` and live
requests (2026-09-19): `{ results, result_count, batch_result_count,
discover_spec_id, is_following_discover_spec, cursor }`. Each item has
`item_type`/`result_type` (`"a"`), `title`, `item_url`
(`https://ladytron.bandcamp.com/album/velocifero?from=discover_page`),
`band_name`, `album_artist`, `band_url`, `price`, `featured_track` (with a
signed `stream_url`, never read) and more.

- → `{ type: "album" (item_type "a"; "t" → "track"), name: title, artist:
  album_artist ?? band_name, slug from item_url }`. On a label-hosted
  release `band_name` is the label and `album_artist` the artist (e.g.
  "Earthshine": band_name "Projekt Records", album_artist "Erik Wøllo").
- `cursor`: an opaque base64 token for the next page of the same tag and
  slice; `null` on the last page. It is passed back verbatim. A response
  without a `cursor` key, or with one that sanitizing would alter, is shape
  drift.
- Unknown tag: `200` with `results: []`, `cursor: null`.
- Bad cursor, or a cursor from another tag/slice: HTTP `500` with body `{}`
  (→ `BandcampUnavailableError` after httpClient's one retry).
- A request discover_web rejects (seen with `size: 60` and
  `include_result_types: ["a","t"]`, which v1 never sends) comes back `200`
  with `{ "__api_special__": "exception", "error_type":
  "Discover_1::DiscoverWebException" }` and no results → shape drift.

## Album / artist / track detail pages

Fetch the plain HTML page (e.g. `https://{artist}.bandcamp.com/album/{slug}`).
Primary extraction source: the `<script type="application/ld+json">` block
(schema.org structured data) — NOT the internal `data-tralbum` player blob
(see spec addendum). Album keys, verified against the captured fixtures
`album-cathedral.html`, `album-nyp.html`, `album-compilation.html`
(2026-09-19):

- `name` → title
- `byArtist.name` → artist (`byArtist["@id"]` is the artist's subdomain; a
  "Various Artists" compilation has `{ "name": "Various Artists" }` with no
  `@id`)
- `description` → free text (sanitize before use)
- `datePublished` → release date (e.g. `"07 Aug 2026 00:00:00 GMT"`)
- `numTracks` (not enforced against the tracklist: pre-orders may differ)
- `track.itemListElement[]` → tracklist, each with `position`, `item.name`,
  `item.duration`, `item["@id"]`, and on compilations `item.byArtist.name`
  (per-track artist; absent on single-artist albums, and on the odd
  compilation track, e.g. track 6 of `sacredbonesrecords/album/todo-muere-sbxv`
  — then the album artist is used). Durations are Bandcamp's non-standard
  `"P00H05M13S"` (no `T`), not `"PT5M13S"`.
- No top-level `offers`. Every purchasable format is an entry in
  `albumRelease[]` with its own `offers` (`price`, `priceCurrency`,
  `priceSpecification.minPrice`) and an `additionalProperty` `item_type`:
  `"a"` digital album, `"p"` physical/merch, `"b"` discography bundle. Only
  the `"a"` entry is the album price; with no `"a"` entry the album has no
  price (never report a vinyl/merch/bundle price).
- Name-your-price: the `"a"` offer is `price: 0`,
  `priceSpecification.minPrice: 0` (page shows "name your price"; seen on
  both new fixtures). Bandcamp digital prices are minimums: a paid album
  ("$9 USD or more") has `price === minPrice > 0` (Cathedral: 9/9 USD).
- Label: `albumRelease[n].recordLabel.name` when present (Cathedral:
  "Sacred Bones Records"). Top-level `publisher` is the page owner — the
  artist on a self-release (same `@id` as `byArtist`, e.g. "John Carpenter",
  "Kiara NGL"), so it is used as label only when its `@id` differs from
  `byArtist["@id"]` (Todo Muere Vol. 3: "Sacred Bones Records"). The `@id`
  test alone is not enough: Bandcamp omits `byArtist["@id"]` for any
  multi-artist credit (a collaboration, a remix crediting the original
  artist, a soundtrack with several composers), so the credited name is
  compared with the publisher's as well — same name, or one occurring inside
  the other at space boundaries once both are NFKC-folded, lowercased,
  stripped of quotes/brackets/periods and split on credit separators
  (`/ , & + × // vs aka and with`, parts of 3+ characters). Verified live
  2026-09-20: it suppresses shadymonk/album/shady-monk-reinterprets… and
  kukangendai/album/zureru while keeping hushhushrecords/album/for-luca
  ("Hush Hush Records") and the compilation fixture. Residual: the field
  still falls back to the publishing account when its name shares nothing
  with the credit (mokhov/album/boards-of-canada-mokhov-remixes → "Mokhov",
  gunpointgame/album/gunpoint-the-soundtrack → "Gunpoint"); nothing on the
  page distinguishes a label account from an artist account there.
- Every outbound string (titles, artist names, labels, the date, search and
  discover names) goes through `sanitizeText`, capped at 300 characters; one
  left empty follows the NotFound/ShapeChanged taxonomy. Tags repeat on live
  pages (bibio/answers lists "electronic" twice) and are deduped
  case-insensitively.
- A JSON-LD root that is not an object (`null`, a string, a number, an
  array) is shape drift.

Fields JSON-LD does NOT reliably carry, with documented raw-HTML fallback
CSS selectors from the reference implementation:
- tags: `.tralbum-tags a.tag`
- about text: `.tralbum-about`
- credits text: `.tralbum-credits`
- (fallback only, if JSON-LD is absent) title: `#name-section .trackTitle`,
  artist: `#name-section a`

### Track pages

Every track has a page, `https://{artist}.bandcamp.com/track/{slug}`: album
tracks as well as standalone singles (verified live 2026-09-19;
`/track/primeval` from the album Cathedral answers 200), so `get_track`
resolves any track page and returns a `TrackDetail`
(`track-primeval.html`, `track-temple-sleeper.html`):

- JSON-LD `@type: "MusicRecording"`: `name`, `byArtist.name`, `duration`
  (`"P00H05M13S"`), `@id` (the track URL → `slug`), `description`
  (optional; falls back to `.tralbum-about`), and tags via `.tralbum-tags`.
- `inAlbum` is a `MusicAlbum`. On an album track it carries its own `@id`,
  the album URL (`track-primeval.html`: `inAlbum["@id"]` =
  `https://johncarpentermusic.bandcamp.com/album/cathedral`; its
  `albumRelease[]` also lists that URL as the `item_type` `"a"` entry) →
  `album: { title, slug }`. On a standalone single
  (`track-temple-sleeper.html`) `inAlbum` has **no** `@id`: it repeats the
  track's own name and lists only the track's own release (`item_type`
  `"t"`) → `album: { title: "Temple Sleeper", slug: null }`.
- Rule (controller ruling 16): `album.title` from `inAlbum.name`, `album.slug`
  only from `inAlbum["@id"]` through the allowlisted url→slug path (never
  from `albumRelease[]`); no `@id` or an unusable one → `slug: null`;
  `album: null` only when `inAlbum` is absent or has no usable name.

### Artist/label pages: no JSON-LD

Artist/label pages (e.g. `https://sacredbonesrecords.bandcamp.com/`) carry
**no** `application/ld+json` block at all — verified against the captured
fixture `tests/fixtures/artist-sacredbones.html` and live pages
(johncarpentermusic, sunn, warprecords; 2026-09-19). Never call
`extractJsonLd` on them. Name/location/bio come from server-rendered markup
(`extractArtistName` / `extractArtistLocation` / `extractArtistBio`):

- name: `#band-name-location .title`
- location: `#band-name-location .location`
- bio: `#bio-text` (inside `.signed-out-artists-bio-text`). Long bios nest an
  overflow `span.peekaboo-text` plus a `span.peekaboo-link` "... more" toggle
  and use `<br>` for line breaks; the toggle is dropped, whitespace collapsed,
  `<br>` turned into newlines, and the remaining tags stripped in the
  extractor, while every raw `<` is still a real tag (a user's `<` arrives as
  `&lt;`). `sanitizeText` then decodes entities once and strips only real tag
  shapes (`<` + letter, `</` + letter, comments), so a user's `<3` or `->`
  survives.
- bio fallback, only when `#bio-text` is absent: `<meta name="description">`,
  whose content reads `"\n{name}.\n{location}.\n{bio}\n"`. The name/location
  preamble is stripped when it matches the page's own values, so an artist
  with no bio (e.g. warprecords: preamble only) yields no bio. Its text is
  double-encoded in places (`O&amp;#39;Malley`), so it is a lesser-evil fallback.

These strings are raw markup (entities intact); `normalizeArtist` runs every
one through `sanitizeText`.

**Fetch `/music`, not the root.** About a third of artist roots answer `303`
to a featured album page (seen live 2026-09-19: songs-of-arrakis, sargept,
1216, bdrmeyes), while `https://{artist}.bandcamp.com/music` is the release
grid (200 + `#music-grid` for rosetta, denzelcurrymusic, lilyseabird,
johncarpentermusic, burial, songs-of-arrakis, sargept, 1216). An artist
whose only release is an album is redirected even from `/music`
(demo--music → `/album/instruments-of-labour`, `artist-landing-album.html`):
that page has no grid, and its JSON-LD release (`extractLandingRelease`) is
the whole discography.

Discography (`extractDiscography`, then `toDiscographyItems`):

- `#music-grid` renders the first 16 releases as `<li>` entries:
  `<a href>` + `<p class="title">Name<br><span class="artist-override">Other
  Artist</span></p>`. The artist-override is present only when the release
  is credited to someone other than the page (a label's roster, a
  collaboration); otherwise the entry's `artist` is null.
- The rest of the catalog is only in the grid's `data-client-items`
  attribute: entity-encoded JSON, `[{ title, page_url, type, artist?, id,
  band_id, art_id }]` (sacredbonesrecords: 16 `<li>` + 384 items; a single
  artist's `/music`: 16 + 10; no overlap seen). A malformed attribute is
  ignored.
- Links are absolute and cross-subdomain on a label page
  (`https://johncarpentermusic.bandcamp.com/album/cathedral?label=…&amp;tab=music`)
  and relative on an artist page (`/album/cathedral`). Each is resolved
  against the `/music` URL and must pass the allowlist to get a slug and
  type; otherwise `slug: null`, `type: "album"`. Entries are deduped by the
  resolved release URL.
- No `#music-grid` → no grid entries (the whole page is never scanned).
  `extractDiscography` reports `{ found, itemCount, entries }`, where
  `itemCount` counts the releases the grid lists (its `<li>` elements plus
  a parseable `data-client-items` array), readable or not.
- **Fails closed** (`getArtist`): no readable grid entries and no release
  JSON-LD → `BandcampShapeChangedError`. That covers no `#music-grid` on a
  page that is not a release landing page, and a grid that lists releases
  none of which parse. Only a present grid that lists nothing
  (`itemCount` 0) yields an empty discography. Not verified live: no
  zero-release artist was found, so how Bandcamp renders one is unknown; if
  it omits `#music-grid`, such an artist would surface as drift, not as an
  empty list.
- Capped at 100 entries (Warp: 834), with `discographyTotal` and
  `discographyTruncated`.

**No tags.** Artist/label pages expose no tags (0 on the fixture and on 5
live roots, 2026-09-19), so `get_artist` has no tags field. Tags are a
property of a release: `get_album` and `get_track` have them.

Artist-page checks: call `assertArtistPage(html)` first. A page with no
`#band-name-location` block has three readings, checked in that order —
`BandcampChallengeError` (challenge markers present), `NotFoundError` (a
`stub-page-content` marker: a subdomain held by a fan account, which answers
200 with a placeholder profile carrying no releases, no `#music-grid` and no
JSON-LD — reachable both from a search result of type `b` and from guessing a
subdomain off a display name), and otherwise `BandcampShapeChangedError`, so
unrecognised markup still fails closed as drift. A block present but without
a `.title` element is drift inside the block; an empty `.title` is a missing
name (`NotFoundError`). Album pages carry the same sidebar and pass, which
the landing-album case relies on. On a stub subdomain `/album/` and `/track/`
return 404, which `httpClient` already maps to `NotFoundError`, so only the
artist path needs the check.

## Headers (all requests)

```
User-Agent: Mozilla/5.0 (compatible; bandcamp-mcp/<version>; +https://github.com/Venut-Technologies/bandcamp-mcp)
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8
Accept-Language: en-US,en;q=0.5
Content-Type: application/json   (POST requests only)
```

`<version>` is package.json's `version` (e.g. `0.1.0`), read at runtime by
`src/version.ts`.

Redirects: every request is sent with `redirect: "manual"`; `httpClient`
follows at most 3 hops itself, resolving each `Location` against the current
URL and re-validating it with `assertSafeBandcampUrl` before fetching it. A hop
off `bandcamp.com`/`*.bandcamp.com` (e.g. an artist's custom domain) is a
`NotFoundError`, and so is a hop to `https://bandcamp.com/signup`: an unclaimed
artist subdomain's root answers `303 Location: https://bandcamp.com/signup?new_domain=<slug>`,
while its `/music` and `/album/<x>` are plain `404`s (all seen live 2026-09-19).
A 3xx without `Location`, or a 4th hop, is `BandcampUnavailableError`.

## Fixtures

Captured with `npx tsx scripts/capture-fixture.ts <url> <file> [--json-body '<json>']`.

**Stream and download URLs are redacted.** Pages and API responses carry
signed, playable audio links: `*.bcbits.com/stream/…` (album/track
`data-tralbum` player attribute, discover_web `featured_track.stream_url`) and
`bandcamp.com/stream_redirect?…` (recommendation tiles' `data-audiourl`). A
free or name-your-price release additionally carries a signed download grant,
`bandcamp.com/download?fsig=…&id=…&ts=…&type=album`, in `data-tralbum`'s
`freeDownloadPage`; that signature stays valid for days and the page it opens
serves per-format `*.bandcamp.com/download/album?…&fsig=…` links, so a
committed capture would be a working purchase-bypass link in the public
repository and in its history. `capture-fixture.ts` replaces every one with
`REDACTED-STREAM-URL` before writing (`scripts/redact-stream-urls.ts`), so a
fixture is not byte-identical to the live response. The pre-existing fixtures
were redacted once in place (2026-09-19; the two `freeDownloadPage` grants in
`album-nyp.html` and `album-compilation.html` on 2026-09-20, when the gate was
widened to cover them), and `tests/fixtures.test.ts` fails if any fixture
still carries one — including a bare `fsig=` check that fails closed on a
signed shape the redactor does not yet know how to clean. Nothing the client
reads lives in those attributes.

| Fixture | Source |
|---|---|
| `album-cathedral.html` | `https://johncarpentermusic.bandcamp.com/album/cathedral` (standard release) |
| `album-nyp.html` | `https://kiarangl.bandcamp.com/album/gloom-garden` (name-your-price, self-released) |
| `album-compilation.html` | `https://sacredbonesrecords.bandcamp.com/album/todo-muere-volume-3` (various artists, also NYP) |
| `artist-sacredbones.html` | `https://sacredbonesrecords.bandcamp.com/` (label root, captured 2026-08-23; same `#music-grid` markup as its `/music` page) |
| `artist-johncarpenter-music.html` | `https://johncarpentermusic.bandcamp.com/music` (single artist, relative hrefs) |
| `artist-landing-album.html` | `https://demo--music.bandcamp.com/music`, which 303s to `/album/instruments-of-labour` |
| `artist-fan-stub.html` | `https://lo-fi-high.bandcamp.com/music` (subdomain held by a fan account: 200 with `<div class="stub-page-content fan">`, no `#band-name-location`, no `#music-grid`, no JSON-LD) |
| `track-primeval.html` | `https://johncarpentermusic.bandcamp.com/track/primeval` (track on an album) |
| `track-temple-sleeper.html` | `https://burial.bandcamp.com/track/temple-sleeper` (standalone single) |
| `search-carpenter.json` | search `"carpenter"`, filter `"a"` |
| `search-sacred-bones-bands.json` | search `"sacred bones"`, filter `"b"` (one label, one artist) |
| `search-primeval-tracks.json` | search `"primeval"`, filter `"t"` |
| `browse-electronic-top.json` | discover_web, tag `electronic`, slice `top`, first page |
