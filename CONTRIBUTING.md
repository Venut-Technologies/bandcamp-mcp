# Contributing

## Development

Requires Node.js 20+.

```bash
npm ci              # exact versions from package-lock.json
npm run build       # compiles src/ into a fresh dist/
npm run typecheck   # src, tests, scripts and vitest.config.ts
npm test            # offline: runs against committed fixtures only
npm run smoke-test  # hits the real Bandcamp; nothing else does
```

- **Tests never touch the network.** Bandcamp data comes from
  `tests/fixtures/`. Capture a new fixture with
  `npx tsx scripts/capture-fixture.ts <url> <file> [--json-body '<json>']`,
  which redacts signed stream and download URLs before writing
  (`tests/fixtures.test.ts` fails if one is left), and record what it shows in
  [docs/bandcamp-endpoints.md](./docs/bandcamp-endpoints.md).
- **stdout belongs to the MCP protocol.** Anything else printed there breaks
  the session; diagnostics go to stderr.
- **Fail closed.** Every schema validation goes through
  `parseOrShapeChanged`, every outbound string through `sanitizeText`, and
  no schema gets a field for stream, download or purchase URLs — see
  [PRINCIPLES.md](./PRINCIPLES.md).
- **Exact pins.** Dependencies are pinned to exact versions, and CI rejects
  a range. Dependabot proposes weekly updates.
- **Packaging.** To check the package as users get it, pack it, install the
  tarball into a scratch project and run the handshake check there:

  ```bash
  npm run build && npm pack --pack-destination /path/to/scratch
  cd /path/to/scratch && npm init -y && npm install ./bandcamp-mcp-*.tgz
  node /path/to/repo/scripts/handshake-check.mjs node_modules/.bin/bandcamp-mcp
  ```

  CI's `package` job does the same on Linux and Windows, Node 20/22/24.

## Legal posture

### Why this project takes on less legal risk than a hosted scraper

This is a free, non-commercial, MIT-licensed project with no server-side
infrastructure: it runs on each user's own machine (stdio transport only),
so Bandcamp requests come from users' own IPs, not a project-run proxy.
Compared to a paid hosted scraping service, a free tool with no central
infrastructure and no revenue is structurally more likely to face a
"please rename/stop" request than commercial action. This is also the
explicit reason v1 stays stdio-only even if a future version adds other
transports.

### Naming / trademark risk

The package and repo use "bandcamp" as the leading word. This is a common,
generally low-incident pattern across the MCP ecosystem (`<vendor>-mcp`),
and we accept it as a known, low-probability risk rather than renaming
pre-emptively. If a real trademark claim ever arrives, the fallback plan is
to rename the package and repo and publish a deprecation notice on the old
npm entry, not to fight it.

## robots.txt

> **Decision (2026-09-21): `bandcamp_search` ships in 0.1.0**, although the
> endpoint behind it sits under `Disallow: /api/`. The grounds are below.

**Last checked: 2026-09-21** (`curl -s https://bandcamp.com/robots.txt`:
HTTP 200, `text/plain`, 1053 bytes; unchanged from the previous check).
Re-check before every release and update this section.

The rules for all user agents, verbatim:

```
User-agent: *
Disallow: /tools
Disallow: /checkout
Disallow: /download_check
Disallow: /cart/
Disallow: /corpbanner/
Disallow: /stream
Disallow: /api/
Disallow: /design_tokens
Disallow: /search

Allow: /api/currency_data/

Allow: /api/discover/1/discover_mobile_web
Allow: /api/discover/1/discover_web
Allow: /api/tag_search/2/related_tags

Disallow: /*_cb$
```

The file also has this block, verbatim:

```
User-agent: ClaudeBot
Disallow: /
```

The rest of the file blocks other named bots with `Disallow: /`
(NextGenSearchBot, GeedoShopProductFinder, EdisterBot, Ezooms, SWEBot,
discobot, SemrushBot, grapeshot, BUbiNG, Bytespider, CCBot, Diffbot,
FacebookBot and meta-externalagent, Google-Extended, GPTBot, omgili,
Amazonbot) and gives ImagesiftBot `Crawl-delay: 5`.

What that means for each path this project requests, under the
`User-agent: *` rules:

| Request | Tool | robots.txt |
|---|---|---|
| `POST https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic` | `bandcamp_search` | **Disallowed** by `Disallow: /api/`; no `Allow` line covers it. |
| `POST https://bandcamp.com/api/discover/1/discover_web` | `bandcamp_browse_tag` | **Allowed** explicitly: `Allow: /api/discover/1/discover_web` is the longer match, so it wins over `Disallow: /api/` (RFC 9309). |
| `https://<artist>.bandcamp.com/album/<item>`, `/track/<item>`, `/music` | `bandcamp_get_album`, `bandcamp_get_track`, `bandcamp_get_artist` | Not covered by bandcamp.com's file, since each subdomain is its own host. The subdomains checked (`johncarpentermusic`, `sacredbonesrecords`) serve the same rules as bandcamp.com, plus a first line `Sitemap: https://<artist>.bandcamp.com/sitemap.xml`. None of those rules matches `/album/`, `/track/` or `/music`, so these pages are **allowed**. |

The HTML search page `/search` is disallowed too, so it is no alternative
to the search API.

**Grounds.** robots.txt is addressed to crawlers. This server is not one:
it makes a request only when a user's MCP client calls a tool — one page or
API call per call, plus any redirects and at most one retry — at most 3 in
flight, at least 150 ms apart. It follows no links, visits no URL it was not
asked for, builds no index, and keeps nothing: every call is fetched live and
the result goes to that user's client alone. Requests identify the project in
their User-Agent
(`Mozilla/5.0 (compatible; bandcamp-mcp/<version>; +https://github.com/Venut-Technologies/bandcamp-mcp)`),
and run from the user's own machine, never from ours. The `ClaudeBot` block
is about Anthropic's crawler, which this is not, whichever model drives it.

What stands against that is also recorded: `Disallow: /api/` alongside three
explicit `Allow`s reads as a deliberate choice about which API paths automated
clients may use, and the search endpoint is not among them; and a model can
issue tool calls in sequence without a person approving each one.

**Commitment.** If Bandcamp objects to this use of the search endpoint, the
project changes the tool or removes it — no argument, no delay. The other four
tools do not depend on it: browse and artist discographies also yield slugs,
and the detail tools take a slug converted from any Bandcamp URL the user has.
What would be lost is finding an artist, release or label by name. This section
is re-checked against the live file before every release; if the rules change,
the decision is made again rather than assumed.

## Release process

**Pushing a `vX.Y.Z` tag is what releases.** Nobody publishes from a laptop.
`.github/workflows/release.yml` builds from the tagged commit, runs the full
check suite again, checks the packed tarball and its MCP handshake, creates
the GitHub Release with the changelog entry as its body, and publishes to npm
with provenance through OIDC trusted publishing — no token is stored anywhere.
If that workflow is red on a tag, the release has not happened: delete the tag
rather than fixing it in place.

A release is **one commit** titled `Release X.Y.Z` that changes only the
version in `package.json` (and the lockfile) and moves the `Unreleased`
section of `CHANGELOG.md` under the new version with today's date. The
version is never bumped inside feature work.

1. Write the changelog first. Every user-visible change should already be in
   `Unreleased` from the commit that made it; move those entries under
   `## [X.Y.Z] - YYYY-MM-DD` and update the link definitions at the foot of
   the file.
2. Set the version: `npm version <patch|minor|major> --no-git-tag-version`
   for a later release, or leave `package.json` alone for 0.1.0, which
   already says `0.1.0`.
3. Commit both as `Release X.Y.Z` on `main`.
4. Tag it annotated, with the first line of the changelog entry as the
   message, and push:

   ```bash
   git tag -a v0.1.0 -m "First release: anonymous, read-only Bandcamp discovery"
   git push origin main --follow-tags
   ```

5. Watch the Release workflow. It stops before publishing if the tag and
   `package.json` disagree, if a check fails, if the tarball carries anything
   but `dist/`, or if the changelog has no entry for this version.

**Before 1.0**, a minor version may change behaviour or break compatibility
and a patch never does; only the latest release is supported, and a fix goes
forward into the next release rather than back into an old one.

**The first publication** is the one case OIDC cannot cover: npm's trusted
publishing is configured per package, and the package does not exist yet.
Either publish `0.1.0` once by hand with 2FA, or use a granular token with the
shortest possible expiry and revoke it immediately after. Then configure
trusted publishing for `Venut-Technologies/bandcamp-mcp` and `release.yml` on
npmjs.com. Re-running the tag's workflow afterwards is safe: it skips
publishing a version the registry already has, so the GitHub Release still
gets created.

A soaking channel (publishing to the npm `next` dist-tag first, and promoting
to `latest` only after a day of green smoke tests) would suit a project whose
parsing can break without notice. It is not the process today: releases go
straight to `latest`, and a regression is fixed forward in the next version.

### MCP registry and directories

"Stable enough to submit to the MCP registry / Glama / Smithery /
PulseMCP" means **7 consecutive green daily smoke-test runs**. Check the
Actions history before submitting, and make sure the README hardening
(disclaimer, how-it-works, troubleshooting, known limitations) is in place
first: submission is the moment of maximum visibility for the `Venut-Technologies`
name. The MCP registry needs a `server.json` whose `name` matches
`package.json`'s `mcpName`, `io.github.Venut-Technologies/bandcamp-mcp`.

## Post-merge checklist

For the maintainer, once this branch is merged. None of these steps has
been run yet.

1. Make the repository public. The README badges, the issues links in the
   README and in tool error messages, and npm provenance all need it.
2. Re-read [robots.txt](#robotstxt) against the live file. The decision to
   ship `bandcamp_search` is recorded there; a change in the rules reopens it.
3. Optional: set the repository variable `SMOKE_MAINTAINER` to a GitHub login
   and the smoke-test tracking issue is assigned to it. Deliberately unset for
   now, so the issue is created unassigned and the pinned issue plus the red
   run are the signal.
4. Run `smoke-test.yml` once by hand (Actions → Bandcamp smoke test → Run
   workflow) and confirm it is green.
5. Force one failure and confirm the tracking issue is created, labeled
   (`smoke-test` plus `smoke:challenge` or `smoke:shape-changed` when that
   applies), assigned and pinned. No input simulates a failure: on a
   throwaway branch, point one check in `scripts/smoke-lib.ts` at a target
   that doesn't exist and run the workflow on that branch.
6. Confirm the first CI run is green, including the `package` job on
   `windows-latest`: the README's Windows config relies on it.
7. Release 0.1.0: the `Release 0.1.0` commit, the annotated `v0.1.0` tag,
   and the first publication by hand or with a short-lived token, as in
   [Release process](#release-process).
8. Configure npm trusted publishing for `Venut-Technologies/bandcamp-mcp`
   and `release.yml` on npmjs.com, and revoke the token if one was used.
   Every later release then publishes with no secret at all, through the
   job's OIDC token (the workflow already has `id-token: write`).
9. After 7 green daily smoke-test runs, submit to the MCP registry with a
   `server.json` matching `mcpName`, then to the other directories.
10. GitHub disables scheduled workflows in a public repository after 60
    days without repository activity. If that happens, re-enable
    `smoke-test.yml`.

## Hardening options (deferred)

- **Pin GitHub Actions by commit SHA.** The workflows use major tags
  (`actions/checkout@v7`, `actions/setup-node@v7`,
  `actions/github-script@v9`). Pinning each to a full commit SHA, with
  Dependabot's `github-actions` updates keeping the pins current, would
  stop a moved tag from changing what runs. Deferred for v1.
