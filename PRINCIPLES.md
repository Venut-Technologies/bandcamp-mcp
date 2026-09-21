# Principles

The first section is how Venut Technologies builds software; it is shared by every project. The second is what this project guarantees to its users and what it refuses to do.

<!-- venut-common-principles:start -->
## How Venut Technologies builds software

These principles apply to every Venut Technologies repository and to everyone who works in one, human or agent. They describe how we build and maintain software; what each product guarantees to its users is stated separately below them.

1. **Documentation tells the truth.** The README states what the project does, for whom, how mature it is, what is supported, and where it stops. Status, compatibility, and limitations are written from what was verified, never from what is planned. No invented adoption, metrics, or endorsements.
2. **Evidence over assumptions.** A claim that something works is backed by running it: the real command, the real environment, the real data or a faithful copy of it. A passing unit test, a mock, a simulator, or "it should work" is not evidence of production behavior. Say what was verified, how, and what was not.
3. **Boundaries are explicit.** What is supported, what is not, and what happens on the unsupported path are written down and tested. Unsupported input, platform, or state fails closed with a clear message; it never guesses, silently degrades, or pretends to succeed.
4. **Small changes with a stated intent.** One task, one branch, focused commits whose messages say why, not just what. No drive-by refactors, no unrelated fixes bundled in, no rewriting what was not asked for. When the task turns out to need more, say so before expanding it.
5. **Secrets and personal data never enter the repository.** No tokens, keys, passwords, signed URLs, or `.env` contents in code, configuration, fixtures, tests, documentation, commit messages, or agent output. No real user data, real library contents, personal file paths, or private email addresses in fixtures and examples: test data is synthetic. If something slips in, it is rotated and removed from reachable history, not just deleted in a later commit.
6. **Respect the ecosystems we touch.** Third-party software, services, formats, and trademarks are named accurately, with an explicit "not affiliated" where the name could imply otherwise. Their data is read and written only through documented or carefully verified paths, never in a way that can corrupt it or violate their terms. Their licences and attribution requirements are followed.
7. **Security issues are visible.** Every public repository has a `SECURITY.md` pointing to `security@venut.tech` for anyone who prefers to report privately. Once a problem is confirmed, it is made public promptly as an issue or advisory with its impact and status, even before a fix exists, so that users can decide for themselves. Small and experimental projects do not promise response times, and say so honestly.
8. **A person decides the irreversible.** An agent or a script does not push to a shared branch, publish a package, make a repository public, rewrite history, delete data, or deploy to a live environment on its own initiative. Each of these happens only on an explicit instruction from the owner for that specific action, and the instruction is recorded where the action is recorded.
<!-- venut-common-principles:end -->

## bandcamp-mcp principles

This server reads Bandcamp on a listener's behalf — someone else's shop, someone else's music,
and no account of yours. These are the guarantees it makes about that, each one anchored in the
code that enforces it and the tests that would fail if it stopped being true.

1. **Anonymous and read-only, with nothing to configure.** There is no login, no API key, no
   token, no cookie and no environment variable: the server starts from `npx -y bandcamp-mcp`
   with no arguments (`src/index.ts`). Every request is a `GET`, or the same `POST` Bandcamp's own
   search and discover pages send, and no tool writes anything anywhere
   (`src/client/bandcampClient.ts`). Nothing is cached or stored on disk, so a session leaves no
   trace of what was asked. Consequence, stated rather than hidden: Bandcamp sees your IP address
   and your queries, and the requests identify themselves with a `bandcamp-mcp` User-Agent
   (`src/client/httpClient.ts`), never as a browser.

2. **Tools take slugs, not URLs, and only Bandcamp's own hosts are ever fetched.** A tool argument
   is an opaque slug matched against a strict pattern, and the request URL is built from it here
   (`src/client/urlSafety.ts`); a URL passed in its place is refused. Redirects are followed by
   hand, at most three, and every hop is re-validated against `bandcamp.com` / `*.bandcamp.com`
   before a socket is opened — an off-host redirect is reported as not found, never followed. The
   same check stands between every URL inside a Bandcamp response and any slug we hand back.
   Covered by `tests/client/urlSafety.test.ts` and by the hostile-`Location` cases in
   `tests/client/httpClient.test.ts`.

3. **No result can carry a stream, download or purchase link, because no field exists for one.**
   The Zod schemas in `src/client/types.ts` have no such field, so normalization cannot pass one
   through and a future contributor cannot add one by accident: validation would reject it.
   Bandcamp's pages do contain signed media URLs; they stay in the page.
   `tests/client/normalize.test.ts` feeds a page carrying them and asserts nothing of the sort
   reaches the output. Captured fixtures in this repository have those URLs redacted, which
   `tests/fixtures.test.ts` enforces.

4. **Text written by strangers is treated as data, not as instructions.** Names, titles, bios,
   descriptions and tags are entity-decoded once, stripped of markup, control and invisible
   characters, and length-capped before they leave the client (`src/client/sanitize.ts`), and every
   tool description tells the model that these fields are user-written and are never instructions
   (`src/tools/shared.ts`). This reduces the risk that a crafted bio steers an assistant; it does
   not remove it, and the README says so. Covered by `tests/client/sanitize.test.ts`.

5. **A broken read is reported as broken, never as an empty answer.** Bandcamp publishes no API,
   so its shapes can change without notice. When they do, the client fails closed: drift in a page
   or response raises "the format changed", a bot-check page raises exactly that, a missing page
   is not found, and an outage is an outage — four distinct errors that the tools turn into four
   distinct messages, each isError, one of them pointing at the issue tracker
   (`src/client/errors.ts`, `src/tools/errorMapping.ts`). A page that parses to nothing is never
   returned as "no results". Covered by `tests/client/normalize.test.ts` and
   `tests/tools/errorMapping.test.ts`.

6. **Polite by construction, at most three requests at a time.** At most three requests are in
   flight, each at least 150 ms after the last, with a 7-second deadline covering headers and body,
   one retry, and a `Retry-After` longer than five seconds refused rather than slept through
   (`src/client/httpClient.ts`). These are constants in one file, not scattered call sites, and
   `tests/client/httpClient.test.ts` fails if any of them stops holding.

7. **Our own monitoring stays within the same limits.** The smoke test that proves the tools still
   work against live Bandcamp runs once a day, after a random delay of up to fifteen minutes so the
   pattern is not a clock tick, and makes a handful of requests through the same paced client
   (`.github/workflows/smoke-test.yml`, `scripts/smoke-lib.ts`). It is monitoring for us, not a
   crawl of Bandcamp: it never walks a catalog, and it is the only automated job that reaches the
   network.

8. **Not affiliated with Bandcamp, and honest about what that means.** The README says so in the
   first screen, names the endpoints used and where they came from
   (`docs/bandcamp-endpoints.md`), and states that any of them can break without notice. How these
   endpoints relate to Bandcamp's `robots.txt` is recorded in `CONTRIBUTING.md` rather than left
   for a reader to wonder about. If Bandcamp objects to a part of this, the project changes or
   drops that part.
