# Privacy

`bandcamp-mcp` runs on your own machine, started by your MCP client. There is no
service behind it: no account, no sign-in, no API key, no server of ours that
your requests pass through.

Everything below is checkable in the source; the file paths say where.

## What it reads

Only what your client sends with a tool call: a search query, a Bandcamp slug
(`artist/album/item`), a genre tag, a sort order, a paging cursor. Nothing else
on your machine is opened — no files, no library, no clipboard, no environment
variables beyond what Node itself needs to start.

## Where it goes on the network

Only to `bandcamp.com` and its `*.bandcamp.com` subdomains, and only when a tool
call asks for something:

- one page or API request per tool call, plus at most one retry and at most
  three redirects, each redirect target re-checked against that host list
  (`src/client/urlSafety.ts`, `src/client/httpClient.ts`);
- at most 3 requests in flight, at least 150 ms apart, with a 7-second deadline
  (`src/client/httpClient.ts`).

Requests carry a User-Agent that names the project and its version:

```
Mozilla/5.0 (compatible; bandcamp-mcp/<version>; +https://github.com/Venut-Technologies/bandcamp-mcp)
```

They do not carry cookies, accounts, tokens or anything identifying you beyond
what any HTTP request carries. **Bandcamp sees your IP address, what you asked
for and when** — the same as if you had opened the page in a browser, because
the request comes from your machine, not from us.

The server reaches no other host. It does not call home, check for updates, or
contact any analytics, error-reporting or telemetry endpoint — there is no such
code, and the host allowlist would refuse it.

## What it writes

Nothing. No cache, no database, no log file, no temporary files. Results go to
your MCP client as the answer to the tool call and are gone when the process
ends. Diagnostics (a Bandcamp outage, a format change) go to stderr, which your
client shows or discards; stdout carries only the MCP protocol.

Your client, and the model behind it, keep their own history of the
conversation, including tool results. That is their storage and their privacy
policy, not this server's.

## Telemetry

None. Not optional, not opt-out: it does not exist.

## Third parties

Bandcamp is not affiliated with this project and has its own privacy policy,
which covers what they do with the requests your machine makes:
<https://bandcamp.com/privacy>. npm sees a download when your client installs or
updates the package, as it does for any npm package.

## Questions

Open an issue: <https://github.com/Venut-Technologies/bandcamp-mcp/issues>. For
anything security-related, see [SECURITY.md](./SECURITY.md).
