# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may
contain breaking changes.

## [Unreleased]

The first release, not yet published: an anonymous, read-only MCP server for
Bandcamp discovery, over stdio, with five tools. Dating this section and
moving it under `## [0.1.0]` is the release commit
(see [CONTRIBUTING.md](./CONTRIBUTING.md#release-process)).

### Added

- `bandcamp_search`: albums, artists, tracks and labels by free text,
  optionally one type only. Labels are told apart from artists by
  Bandcamp's `is_label` flag.
- `bandcamp_get_album`: title, artist, release date, label, tags,
  description, the digital price (`priceText`, `priceCurrency`,
  `isNameYourPrice`) and the tracklist with each track's own artist.
- `bandcamp_get_artist`: name, location, bio and discography for an artist
  or label.
- `bandcamp_get_track`: one track page, with the album it belongs to.
- `bandcamp_browse_tag`: releases by tag, or unfiltered, sorted `top` or
  `new`, 20 per page with a cursor. It replaces a separate discover tool.
- Tools take slugs, never URLs, and only `bandcamp.com` /
  `*.bandcamp.com` hosts are fetched. Every text field is sanitized and
  length-capped, and no result has a field for stream or download links.
- Requests have a 7 s timeout, one retry (network errors, 5xx, 429 with
  `Retry-After`), at most 3 in flight and pacing between them, and a
  `bandcamp-mcp/<version>` User-Agent.
- Errors tell a format change, a bot check, an outage and "not found"
  apart, and the first two link to the issue tracker.
- A daily smoke test runs eight live checks and reports to a pinned
  tracking issue.

### Notes

Where this server's behaviour may surprise someone who expects a
straightforward Bandcamp reader:

- **`get_track` resolves any track page.** Every album track has a page of
  its own (e.g. `johncarpentermusic/track/primeval`
  from the album Cathedral). The tool resolves any track page and says
  which album the track is on.
- **`TrackDetail`.** `bandcamp_get_track` returns its own shape,
  `{title, artist, durationSeconds, slug, album: {title, slug} | null,
  tags, description}`, instead of the tracklist's `Track` (which keeps
  `position`). On a standalone single, `album` repeats the track's title
  with `slug: null`.
- **Node.js 20+.** Node 18 is end-of-life, and a runtime
  dependency (`@hono/node-server`, via the MCP SDK) and the test runner
  require Node 20. `engines` is `>=20`; CI covers Node 20, 22 and 24.
- **No tags for artists and labels.** Their pages carry none, so the
  `bandcamp_get_artist` result has no tags field; tags belong to a release.
- **Discography cap.** At most 100 entries (a label like Warp lists 834),
  with `discographyTotal` and `discographyTruncated`, and a per-entry
  `artist` for a label's releases. The discography is read from the
  `/music` page, since many artist roots redirect to a featured album.
- **Artist pages are read from markup.** They carry no JSON-LD block, so
  name, location, bio and discography come from the page's HTML.
- **Redirects and custom domains.** Redirects are followed by hand (at
  most 3), and each hop is checked against the `bandcamp.com` host list. A
  redirect to an artist's own domain is not followed: the tool reports
  not-found with that reason. Search and browse results on a custom domain
  have `slug: null`.
- **`priceCurrency`.** Added next to `priceText` (ISO 4217, from the same
  offer), since a price of "9" alone is ambiguous.

[Unreleased]: https://github.com/Venut-Technologies/bandcamp-mcp/commits/main
