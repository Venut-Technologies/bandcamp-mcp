# bandcamp-mcp

[![npm](https://img.shields.io/npm/v/bandcamp-mcp.svg)](https://www.npmjs.com/package/bandcamp-mcp)
[![CI](https://github.com/Venut-Technologies/bandcamp-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Venut-Technologies/bandcamp-mcp/actions/workflows/ci.yml)
[![Bandcamp smoke test](https://github.com/Venut-Technologies/bandcamp-mcp/actions/workflows/smoke-test.yml/badge.svg)](https://github.com/Venut-Technologies/bandcamp-mcp/actions/workflows/smoke-test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Dig through Bandcamp by talking to Claude: chase a label's roster, see what is
new under a tag, pull up an album's tracklist and price, and find who actually
made track 7 on that compilation. `bandcamp-mcp` is a local
[MCP](https://modelcontextprotocol.io) server — the way an AI assistant reaches
tools on your machine — so any MCP client can use it: Claude Desktop, Claude
Code, Cursor, VS Code. No account, no API key, nothing to configure.

**Status: experimental.** Pre-1.0 and actively developed: a minor version may
change behaviour or break compatibility, a patch never does. Only the latest
release is supported.

**Not affiliated with, endorsed by, or sponsored by Bandcamp.**

## What you can ask

- "What has Sacred Bones put out lately, and who's on it?"
- "Find the album *Cathedral* by John Carpenter and read me the tracklist with
  track lengths."
- "What's new under the tag `drum-bass` this week? Give me ten, with the label
  for each."
- "Is that compilation various-artists? Tell me who made each track."
- "How much is this album, and is it name-your-price?"
- "Find that Bandcamp link a friend sent me and tell me what else the artist
  has released."

Answers come from Bandcamp's own public pages, fetched live — one request per
tool call the assistant makes. The server reads; it never buys, downloads or
touches an account, and it has no field in which a stream or download link
could reach you.

## Install

`npx` is the whole install: your MCP client starts the server on demand and
picks up fixes the next time it launches.

**Claude Code:**

```bash
claude mcp add bandcamp -- npx -y bandcamp-mcp
```

**Claude Desktop** (Settings → Developer → Edit Config), or any MCP client that
starts a stdio server from a command:

```json
{
  "mcpServers": {
    "bandcamp": {
      "command": "npx",
      "args": ["-y", "bandcamp-mcp"]
    }
  }
}
```

**Cursor:** [install in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=bandcamp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImJhbmRjYW1wLW1jcCJdfQ%3D%3D),
or add the same JSON block to `~/.cursor/mcp.json`.

**VS Code** (Copilot agent mode): [install in VS Code](https://insiders.vscode.dev/redirect/mcp/install?name=bandcamp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22bandcamp-mcp%22%5D%7D),
or run `code --add-mcp '{"name":"bandcamp","command":"npx","args":["-y","bandcamp-mcp"]}'`.

**Claude Code plugin:** this repository is also a plugin
(`.claude-plugin/plugin.json`), so `/plugin` can install it once it is listed.

### Requirements, and what is actually tested

**Node.js 20 or newer** (22 LTS recommended); Node 18 is end-of-life and a
dependency of the MCP SDK requires 20. Every push runs the test suite on Node
20, 22 and 24, then packs the package, installs it into an empty project and
starts it through an MCP handshake on **Linux, macOS and Windows**, on each of
those Node versions. Nothing else is claimed: other platforms may well work,
but no one has measured them.

Bandcamp itself has no versioned API. What the server reads is whatever
bandcamp.com serves today, which is why a smoke test runs against the live site
daily (badge above) and why a tool can start failing without warning — see
[How this works](#how-this-works-and-why-it-can-break).

To pin a version, use `bandcamp-mcp@<version>` (e.g. `npx -y bandcamp-mcp@0.1.0`).
An unpinned `npx -y bandcamp-mcp` picks up fixes the next time your client
starts it; a pinned or globally installed copy does not (see
[Known limitations](#known-limitations)).

### Windows

GUI MCP clients on Windows often can't start `npx` directly, because it is
a `.cmd` script. Wrap it in `cmd /c`:

```json
{
  "mcpServers": {
    "bandcamp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "bandcamp-mcp"]
    }
  }
}
```

With Claude Code:

```bash
claude mcp add bandcamp -- cmd /c npx -y bandcamp-mcp
```

CI checks this command: on `windows-latest`, the `package` job installs the
packed package into a project and runs `cmd /c npx -y bandcamp-mcp` there
through an MCP handshake (initialize, then tools/list). There, npx finds the
installed copy instead of downloading it, so the check covers how the
server starts on Windows, not the download.

### Troubleshooting: "server disconnected" / `spawn npx ENOENT`

GUI-launched MCP clients often start servers with a minimal `PATH` that
leaves out nvm/volta shims, even when `npx -y bandcamp-mcp` works in your
terminal. Install the package globally and point the client at absolute
paths instead:

```bash
npm install -g bandcamp-mcp
which node                                         # the "command" below (Windows: where node)
echo "$(npm root -g)/bandcamp-mcp/dist/index.js"   # the "args" entry below
```

```json
{
  "mcpServers": {
    "bandcamp": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/node_modules/bandcamp-mcp/dist/index.js"]
    }
  }
}
```

On Windows, every backslash in the JSON paths must be doubled, e.g.
`C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\bandcamp-mcp\\dist\\index.js`.
A global install doesn't update itself: run
`npm install -g bandcamp-mcp@latest` to pick up a fix.

### If your network blocks the npm registry

`npx` looks the package up on `registry.npmjs.org` whenever your client
starts the server. If the registry is blocked, or only sometimes reachable,
run `npm install -g bandcamp-mcp` once while you have access and use the
absolute-path config above, which starts without the registry.

## How this works, and why it can break

Bandcamp has no public catalog API, so every tool call makes live requests
to the same endpoints Bandcamp's own website uses:

- `bandcamp_search`: the JSON endpoint behind Bandcamp's search box
  (`/api/bcsearch_public_api/1/autocomplete_elastic`);
- `bandcamp_browse_tag`: the JSON endpoint behind bandcamp.com/discover
  (`/api/discover/1/discover_web`);
- `bandcamp_get_album` and `bandcamp_get_track`: the public release or
  track page, read mostly from its schema.org JSON-LD block, with tags from
  the page markup;
- `bandcamp_get_artist`: the artist's or label's `/music` page, read from
  its markup.

None of these is a published, versioned API. Bandcamp can change them at any
time and without notice, and a tool then stops working until this project
ships a fix. When that happens the tool says so ("Bandcamp's response format
looks like it changed", or that it got a bot check instead of data) and
links to the issues page. A daily smoke test (badge above) runs every tool's
client code against live Bandcamp pages and reports failures to a tracking
issue. The endpoint notes are in
[docs/bandcamp-endpoints.md](./docs/bandcamp-endpoints.md).

- **Metadata only.** Releases are identified by slug, and the result
  schemas (`src/client/types.ts`) have no field for stream, download or
  purchase links, so the signed audio links in Bandcamp's pages can't pass
  through. (Free-text fields are the artists' own words, and may mention
  links.)
- **No caching or republishing.** Every tool call is fetched live. Nothing
  is stored; results go to your MCP client and nowhere else.
- **No telemetry.** Neither this package nor Venut Technologies collects
  anything; what the server reads, sends and stores is listed in
  [PRIVACY.md](./PRIVACY.md).
  But every tool call is a request from your machine straight to Bandcamp,
  which sees your IP address, what you asked for and when. The requests also
  say where they come from, with the User-Agent
  `Mozilla/5.0 (compatible; bandcamp-mcp/<version>; +https://github.com/Venut-Technologies/bandcamp-mcp)`,
  so they don't look like a browser visit.
- **Gentle by design.** At most 3 requests in flight, at least 150 ms
  apart, a 7-second timeout, and one retry for a timeout, a transport-level
  failure (a reset or closed socket, a DNS or TLS error), 5xx or 429
  (honoring a `Retry-After` of up to 5 s). Only `bandcamp.com`
  and `*.bandcamp.com` hosts are ever fetched: redirects are followed by
  hand (at most 3) and each target is checked against that list.

Bandcamp's `robots.txt` closes `/api/` to crawlers, which covers the search
endpoint, and explicitly allows the browse one. This server is not a crawler:
it fetches one page per tool call you make, follows no links and stores
nothing. That reading, the argument against it, and the commitment to change
or drop a tool if Bandcamp objects are all recorded in
[CONTRIBUTING.md](./CONTRIBUTING.md#robotstxt).

The repository (not the npm package) contains pages and API responses
captured from Bandcamp as test fixtures, with the signed stream and download
URLs redacted, the identities and free text replaced by invented ones, and
each page cut down to the markup the parsers read.

Found a bug, or have an abuse concern? Please open an issue:
https://github.com/Venut-Technologies/bandcamp-mcp/issues

Security problems go privately to security@venut.tech instead; see
[SECURITY.md](./SECURITY.md).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `bandcamp_search` | `query` (1–200 characters); `type`: `all` (default), `album`, `artist`, `track` or `label` | Ranked matches, each `{type, name, artist, slug}`. Artists and labels are told apart by Bandcamp's `is_label` flag on each result. |
| `bandcamp_get_album` | `slug`, e.g. `johncarpentermusic/album/cathedral` | Title, artist, release date, label, tags, description, the digital price (`priceText` is the minimum, with `priceCurrency`; `isNameYourPrice`), and the tracklist: each track's own artist (compilations), position, duration and slug. |
| `bandcamp_get_artist` | `slug`: the artist's or label's subdomain, e.g. `sacredbonesrecords` | Name, location, bio and discography: at most 100 entries `{title, slug, type, artist}` (on a label page, `artist` is each release's own artist). `discographyTotal` counts all releases; `discographyTruncated` says whether some were cut. No tags. |
| `bandcamp_get_track` | `slug`, e.g. `johncarpentermusic/track/primeval` | Any track page, whether a track on an album or a standalone single: title, artist, duration, tags, description, and `album` `{title, slug}`, the album it belongs to (on a standalone single: the track's own title with `slug: null`; `null` when the page names no album at all). |
| `bandcamp_browse_tag` | `tag` (optional): a Bandcamp tag slug such as `ambient`, `drum-bass` or `русский-рок`; `sort`: `top` (default) or `new`; `cursor` (optional) | Up to 20 releases per page, each `{type, name, artist, slug}`, plus `nextCursor` for the next page. Omit `tag` for an unfiltered listing across Bandcamp. A free-form tag is normalized to slug form (`Drum & Bass` → `drum-bass`). A cursor only works with the tag and sort it came from. |

Every `slug` is a Bandcamp identifier copied from an earlier result
(`<subdomain>/album/<item>`, `<subdomain>/track/<item>`, or a bare subdomain
for an artist or label), never a display name. The tools take no URLs: a
Bandcamp URL `https://<subdomain>.bandcamp.com/album/<item>` becomes the
slug `<subdomain>/album/<item>`, and the tool descriptions tell the model
so. A result whose slug is `null` can't be looked up (see custom domains
below).

## Known limitations

- **Single-maintainer, best-effort project, with no SLA.** The daily smoke
  test is monitoring, not a support guarantee.
- **Prompt injection.** Names, titles, bios, descriptions and tags are
  written by Bandcamp users, and anyone can publish on Bandcamp. This
  server decodes entities, strips markup and control and invisible
  characters, and caps their length, and every tool description tells the
  model to treat them as data, never as instructions. That reduces the risk
  of a crafted bio steering your assistant; it does not eliminate it.
- **Pinned and global installs don't self-heal.** When Bandcamp changes
  something and a fix ships, only unpinned `npx` setups get it
  automatically. A copy pinned to `@x.y.z` or installed with
  `npm install -g` keeps failing, and the error can't tell you a fix
  exists. If a tool reports that Bandcamp's format changed, check the
  [issues](https://github.com/Venut-Technologies/bandcamp-mcp/issues) and
  [CHANGELOG](./CHANGELOG.md), then update.
- **Custom domains.** The server only fetches `bandcamp.com` and
  `*.bandcamp.com` hosts, as protection against being steered to other
  servers (SSRF). A release, artist or label that Bandcamp lists under its
  own domain (e.g. `ilistentojohn.com`, seen in a search for "carpenter") comes
  back with `slug: null` and can't be looked up from that result, and an
  artist whose subdomain redirects to its own domain is reported as not
  found, with that reason.
- **No tags for artists and labels.** Their pages don't carry any, so
  `bandcamp_get_artist` returns none; `bandcamp_get_album` has a release's
  tags.
- **An album's `label` can name the hosting account.** When the page states
  no record label, the field falls back to the Bandcamp account that
  published the release. That is right for a label's own page, and the
  server suppresses it when the account is one of the credited artists — but
  on a self-published release with a multi-artist credit whose account name
  shares nothing with it (a band, a game studio, a collective), the account
  is reported as the label.
- **Long catalogs are cut at 100 releases** in `bandcamp_get_artist`.
- **Cancelling doesn't stop the request.** A tool call your client cancels
  still finishes its Bandcamp request in the background (bounded by the
  timeout); v1 doesn't pass cancellation through.
- **No "recommended" sort.** Bandcamp personalizes that only for logged-in
  fan accounts, and this project is intentionally credential-free, so
  `bandcamp_browse_tag` offers `top` and `new`.
- **Out of scope:** logging in, your collection or wishlist, purchases,
  sales data, and remote (HTTP/SSE) transport. The server runs locally over
  stdio only.

## Principles

What this server guarantees and what it refuses to do — anonymous and read-only,
slugs instead of URLs, no field that could carry a stream or download link, an
honest error when Bandcamp changes — is written down, with the code and tests that
enforce each one, in [PRINCIPLES.md](./PRINCIPLES.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT; see [LICENSE](./LICENSE).
