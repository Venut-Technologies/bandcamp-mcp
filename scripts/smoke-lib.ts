// The smoke-test canary's logic, kept free of side effects so the offline
// suite can run it against a fake client (tests/smoke-lib.test.ts). The runner
// that touches the real network is scripts/smoke-test.ts.
//
// Every client function, against structurally different targets (a
// plain album, a various-artists compilation, a name-your-price release, a
// label page, a track, a tag-filtered and an unfiltered browse). "Didn't
// throw" is not a pass: each check also asserts on the content, so a
// normalizer that silently drops everything fails the canary.
import type * as BandcampClient from "../src/client/bandcampClient.js";
import {
  BandcampChallengeError,
  BandcampShapeChangedError,
  BandcampUnavailableError,
  NotFoundError,
} from "../src/client/errors.js";
import { sanitizeText } from "../src/client/sanitize.js";
import type { Album } from "../src/client/types.js";

export type SmokeClient = Pick<typeof BandcampClient, "search" | "getAlbum" | "getArtist" | "getTrack" | "browseTag">;

export type FailureKind = "challenge" | "shape-changed" | "not-found" | "unavailable" | "assertion" | "other";

export interface SmokeCheck {
  name: string;
  // What was fetched, for the issue report.
  target: string;
  run(client: SmokeClient): Promise<void>;
}

export type CheckResult =
  | { name: string; target: string; ok: true }
  | {
      name: string;
      target: string;
      ok: false;
      kind: FailureKind;
      errorName: string;
      message: string;
      httpStatus?: number;
      pageTitle?: string;
    };

export interface SmokeSummary {
  timestamp: string;
  ok: boolean;
  results: CheckResult[];
}

export class SmokeAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeAssertionError";
  }
}

export class SmokeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeTimeoutError";
  }
}

// Builds a check from a call and its pass conditions. `verify` lists every
// broken condition; any at all fails the check as an assertion.
function check<T>(
  name: string,
  target: string,
  call: (client: SmokeClient) => Promise<T>,
  verify: (value: T) => string[]
): SmokeCheck {
  return {
    name,
    target,
    async run(client) {
      const problems = verify(await call(client));
      if (problems.length > 0) throw new SmokeAssertionError(problems.join("; "));
    },
  };
}

function problemsIf(conditions: Array<[broken: boolean, problem: string]>): string[] {
  return conditions.filter(([broken]) => broken).map(([, problem]) => problem);
}

function standardAlbumProblems(album: Album): string[] {
  return problemsIf([
    [album.tracks.length === 0, "album has no tracks"],
    [album.title.trim() === "", "album title is empty"],
  ]);
}

// Real releases, confirmed against the committed fixtures
// (docs/bandcamp-endpoints.md): album-cathedral.html, album-compilation.html,
// album-nyp.html, artist-sacredbones.html, track-primeval.html.
const STANDARD_ALBUM = "johncarpentermusic/album/cathedral";
const COMPILATION_ALBUM = "sacredbonesrecords/album/todo-muere-volume-3";
const NAME_YOUR_PRICE_ALBUM = "kiarangl/album/gloom-garden";
const LABEL = "sacredbonesrecords";
const TRACK = "johncarpentermusic/track/primeval";

// "<subdomain>/<album|track>/<item>" → its page URL, for the report.
function pageUrl(slug: string): string {
  const [subdomain, ...path] = slug.split("/");
  return `https://${subdomain}.bandcamp.com/${path.join("/")}`;
}

export const SMOKE_CHECKS: SmokeCheck[] = [
  check(
    "search",
    'search "carpenter" (type all)',
    (client) => client.search("carpenter", "all"),
    (results) =>
      problemsIf([
        [results.length === 0, "search returned no results"],
        [results.length > 0 && results.every((r) => r.slug === null), "no search result has a slug"],
      ])
  ),
  check("album (standard)", pageUrl(STANDARD_ALBUM), (client) => client.getAlbum(STANDARD_ALBUM), standardAlbumProblems),
  check(
    "album (various-artists)",
    pageUrl(COMPILATION_ALBUM),
    (client) => client.getAlbum(COMPILATION_ALBUM),
    (album) => {
      const artists = new Set(album.tracks.map((t) => t.artist)).size;
      return problemsIf([[artists < 2, `expected at least 2 distinct track artists, got ${artists}`]]);
    }
  ),
  check(
    "album (name-your-price)",
    pageUrl(NAME_YOUR_PRICE_ALBUM),
    (client) => client.getAlbum(NAME_YOUR_PRICE_ALBUM),
    (album) =>
      problemsIf([[album.isNameYourPrice !== true, `expected isNameYourPrice to be true, got ${album.isNameYourPrice}`]])
  ),
  check(
    "artist (label)",
    // getArtist reads the /music release grid, not the root.
    `https://${LABEL}.bandcamp.com/music`,
    (client) => client.getArtist(LABEL),
    ({ discography }) =>
      problemsIf([
        [discography.length === 0, "discography is empty"],
        [discography.length > 0 && discography.every((d) => d.slug === null), "no discography entry has a slug"],
        [discography.length > 0 && discography.every((d) => d.artist === null), "no discography entry names its artist"],
      ])
  ),
  check(
    "track",
    pageUrl(TRACK),
    (client) => client.getTrack(TRACK),
    (track) =>
      problemsIf([
        [track.title.trim() === "", "track title is empty"],
        [track.album === null, "track has no album"],
      ])
  ),
  check(
    "browse (tag, top)",
    "discover tag=electronic sort=top",
    (client) => client.browseTag("electronic", "top"),
    (page) =>
      problemsIf([
        [page.results.length === 0, "browse returned no results"],
        [typeof page.nextCursor !== "string", "browse returned no nextCursor"],
      ])
  ),
  check(
    "browse (unfiltered, new)",
    "discover tag=(none) sort=new",
    (client) => client.browseTag(null, "new"),
    (page) => problemsIf([[page.results.length === 0, "browse returned no results"]])
  ),
];

// Bandcamp sits behind Fastly/Varnish, so the Cloudflare markers the client
// looks for may never fire: a 403 or 429 is the likelier shape of a block or
// rate limit, and counts as a challenge candidate. `httpStatus` is the error's
// own status or, when it has none (e.g. a 429 whose Retry-After was too long
// to wait for), the status of the last response seen.
const CHALLENGE_STATUSES = new Set([403, 429]);

export function classifyError(err: unknown, httpStatus?: number): FailureKind {
  if (err instanceof SmokeAssertionError) return "assertion";
  if (err instanceof BandcampChallengeError) return "challenge";
  if (err instanceof BandcampShapeChangedError) return "shape-changed";
  if (err instanceof NotFoundError) return "not-found";
  if (err instanceof BandcampUnavailableError) {
    return httpStatus !== undefined && CHALLENGE_STATUSES.has(httpStatus) ? "challenge" : "unavailable";
  }
  return "other";
}

export interface ObservedResponse {
  status: number;
  pageTitle: Promise<string | undefined>;
}

export interface RunOptions {
  // Longer than the client's own worst case for one request (two 7 s attempts
  // plus backoff or Retry-After), so it only fires on a real hang.
  checkTimeoutMs?: number;
  // Hands over the last HTTP response seen since the previous call (the
  // runner wires it to recordResponses); used for a failure's status and title.
  takeLastResponse?: () => ObservedResponse | undefined;
  now?: () => Date;
}

const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
const TITLE_WAIT_MS = 5_000;

// Settles like `promise`, or with `onTimeout()` after `ms`. The timer is
// cleared either way, so a finished run leaves nothing holding the process.
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => Promise.resolve().then(onTimeout).then(resolve, reject), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runCheck(check: SmokeCheck, client: SmokeClient, options: RunOptions): Promise<CheckResult> {
  const timeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  options.takeLastResponse?.();
  try {
    await withTimeout(check.run(client), timeoutMs, () => {
      throw new SmokeTimeoutError(`check did not finish within ${timeoutMs} ms`);
    });
    return { name: check.name, target: check.target, ok: true };
  } catch (err) {
    const observed = options.takeLastResponse?.();
    const errorStatus = err instanceof BandcampUnavailableError ? err.status : undefined;
    const httpStatus = errorStatus ?? observed?.status;
    const pageTitle = observed ? await withTimeout(observed.pageTitle, TITLE_WAIT_MS, () => undefined) : undefined;
    return {
      name: check.name,
      target: check.target,
      ok: false,
      kind: classifyError(err, httpStatus),
      errorName: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(pageTitle !== undefined ? { pageTitle } : {}),
    };
  }
}

// Sequential on purpose: the canary should look like one user, and the client
// paces its own requests.
export async function runSmoke(
  checks: SmokeCheck[],
  client: SmokeClient,
  options: RunOptions = {}
): Promise<SmokeSummary> {
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const results: CheckResult[] = [];
  for (const smokeCheck of checks) {
    results.push(await runCheck(smokeCheck, client, options));
  }
  return { timestamp, ok: results.every((r) => r.ok), results };
}

export function formatSummary(summary: SmokeSummary): string {
  const lines = summary.results.map((r) => {
    if (r.ok) return `- [OK] ${r.name} — ${r.target}`;
    const details = [
      r.httpStatus !== undefined ? `HTTP ${r.httpStatus}` : null,
      r.pageTitle !== undefined ? `page title ${JSON.stringify(r.pageTitle)}` : null,
    ].filter((d) => d !== null);
    const context = details.length > 0 ? ` (${details.join(", ")})` : "";
    return `- [FAIL] ${r.name} — ${r.target} — ${r.kind}: ${r.errorName}${context}: ${r.message}`;
  });
  const passed = summary.results.filter((r) => r.ok).length;
  return [
    `Bandcamp smoke test — ${summary.timestamp}`,
    ...lines,
    `${summary.results.length} checks: ${passed} passed, ${summary.results.length - passed} failed`,
  ].join("\n");
}

const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;
const MAX_TITLE_LENGTH = 200;

// A page title is Bandcamp-supplied text headed for a GitHub issue, so it is
// sanitized and capped like any other free text.
export function extractPageTitle(html: string): string | undefined {
  const raw = html.match(TITLE_PATTERN)?.[1];
  const title = sanitizeText(raw?.replace(/\s+/g, " "), MAX_TITLE_LENGTH).text;
  return title === "" ? undefined : title;
}

// Wraps fetch so the runner can report what Bandcamp actually answered when a
// check fails — the client's errors don't carry the page. An HTML body is read
// through a clone, eagerly, so the title survives the client discarding the
// original (it does for every non-OK response).
export function recordResponses(fetchImpl: typeof fetch): {
  fetch: typeof fetch;
  takeLast: () => ObservedResponse | undefined;
} {
  let last: ObservedResponse | undefined;
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    const isHtml = /html/i.test(response.headers.get("content-type") ?? "");
    last = {
      status: response.status,
      pageTitle:
        isHtml && response.body
          ? response
              .clone()
              .text()
              .then(extractPageTitle, () => undefined)
          : Promise.resolve(undefined),
    };
    return response;
  };
  return {
    fetch: recordingFetch,
    takeLast() {
      const observed = last;
      last = undefined;
      return observed;
    },
  };
}
