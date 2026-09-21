import { BandcampChallengeError, BandcampUnavailableError, NotFoundError } from "./errors.js";
import { assertSafeBandcampUrl } from "./urlSafety.js";
import { VERSION } from "../version.js";

const DEFAULT_TIMEOUT_MS = 7000;
const MAX_RETRIES = 1;
const MIN_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 800;
export const MAX_CONCURRENT_REQUESTS = 3;
const MIN_REQUEST_SPACING_MS = 150;
export const MAX_REDIRECTS = 3;
// A longer Retry-After would hold a concurrency slot past any MCP client's
// tool-call timeout, so the request fails fast instead of sleeping.
const MAX_RETRY_AFTER_MS = 5000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const USER_AGENT = `Mozilla/5.0 (compatible; bandcamp-mcp/${VERSION}; +https://github.com/Venut-Technologies/bandcamp-mcp)`;

let inFlight = 0;
let lastRequestAt = 0;
const waiters: Array<() => void> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_REQUESTS) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}

function releaseSlot(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

async function pace(): Promise<void> {
  // Reserve the next allowed start time synchronously, before any await —
  // concurrent callers (up to MAX_CONCURRENT_REQUESTS can reach this near-
  // simultaneously) must each claim a distinct slot in the schedule rather
  // than all reading the same stale lastRequestAt and racing to fire at once.
  const now = Date.now();
  const nextAllowed = Math.max(now, lastRequestAt + MIN_REQUEST_SPACING_MS);
  lastRequestAt = nextAllowed;
  const delay = nextAllowed - now;
  if (delay > 0) {
    await sleep(delay);
  }
}

function jitterBackoff(): number {
  return MIN_BACKOFF_MS + Math.random() * (MAX_BACKOFF_MS - MIN_BACKOFF_MS);
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
}

interface Hop {
  url: string;
  method: "GET" | "POST";
  body: unknown;
}

function rawFetch(hop: Hop, signal: AbortSignal): Promise<Response> {
  return fetch(hop.url, {
    method: hop.method,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      ...(hop.body ? { "Content-Type": "application/json" } : {}),
    },
    body: hop.body ? JSON.stringify(hop.body) : undefined,
    // Redirects are followed by fetchFollowingRedirects, which re-validates every hop.
    redirect: "manual",
    signal,
  });
}

// Lets fetch release the connection of a response whose body is never read.
function discardBody(response: Response): void {
  response.body?.cancel().catch(() => {});
}

// A redirect target is re-validated against the Bandcamp hostname allowlist
// before it is fetched: following a Location header blindly would hand an
// attacker-chosen host the request this server built from a slug.
function redirectTarget(response: Response, currentUrl: string, requestedUrl: string): string {
  const location = response.headers.get("Location");
  let target: URL | undefined;
  try {
    if (location) target = new URL(location, currentUrl);
  } catch {
    // An unparseable Location is reported below, like a missing one.
  }
  if (!target) {
    throw new BandcampUnavailableError(
      `Bandcamp answered ${response.status} for ${requestedUrl} without a usable Location header`
    );
  }
  try {
    assertSafeBandcampUrl(target.href);
  } catch (err) {
    throw new NotFoundError(
      `${requestedUrl} redirects outside bandcamp.com (e.g. to an artist's custom domain), which this server does not follow`,
      { cause: err }
    );
  }
  // An unclaimed artist subdomain answers 303 to the signup page.
  if (target.hostname === "bandcamp.com" && target.pathname === "/signup") {
    throw new NotFoundError(`No such Bandcamp artist: ${requestedUrl} redirects to Bandcamp's signup page`);
  }
  return target.href;
}

// Sends one request, following at most MAX_REDIRECTS redirects itself. Every
// hop runs under the caller's concurrency slot and deadline and is paced like
// any other request (the caller paces the first one).
async function fetchFollowingRedirects(url: string, options: RequestOptions, signal: AbortSignal): Promise<Response> {
  let hop: Hop = { url, method: options.method ?? "GET", body: options.body };
  for (let redirects = 0; ; redirects++) {
    const response = await rawFetch(hop, signal);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    discardBody(response);
    if (redirects === MAX_REDIRECTS) {
      throw new BandcampUnavailableError(`Too many redirects (more than ${MAX_REDIRECTS}) for ${url}`);
    }
    const next = redirectTarget(response, hop.url, url);
    // 303 See Other re-sends as a bodiless GET; the others keep method and body.
    hop = response.status === 303 ? { url: next, method: "GET", body: undefined } : { ...hop, url: next };
    await pace();
  }
}

// Reads the body under the request's deadline. Fetch itself errors the body
// when its signal aborts; racing the signal here also bounds a body source
// that ignores it.
function readBodyText(response: Response, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    response
      .text()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function isRetryableNetworkError(err: unknown): boolean {
  // AbortSignal.timeout aborts with a TimeoutError; a plain abort is an AbortError.
  if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) return true;
  // Anything undici surfaces with a string `cause.code` is a transport-level
  // failure, and every one of them is worth one retry: ECONNRESET, ENOTFOUND
  // and ETIMEDOUT, but equally ECONNREFUSED, EAI_AGAIN, the TLS codes
  // (CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID, ...) and undici's own
  // UND_ERR_SOCKET — "other side closed", the keep-alive race against a CDN
  // that undici does not retry itself, so an enumerated allowlist turned a
  // routine transient into "Bandcamp is temporarily unavailable". An error
  // without such a code (a bug in this module, a rejected body) is not
  // retried. Redirect-policy verdicts are thrown as NotFoundError /
  // BandcampUnavailableError before this check, and HTTP statuses never reach
  // it, so nothing else lands here.
  return typeof (err as { cause?: { code?: unknown } })?.cause?.code === "string";
}

// Returns the body of a 2xx response. The concurrency slot is held, and each
// attempt's deadline runs, until the body has been read. A retryable network
// error (a timeout, a TLS failure, a reset or closed socket, a DNS failure,
// ...) is retried once, whether it hits while waiting for the headers or
// while reading the body.
async function requestText(url: string, options: RequestOptions): Promise<string> {
  await acquireSlot();
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await pace();
      const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchFollowingRedirects(url, options, signal);
      } catch (err) {
        // Redirect-policy verdicts are final, not network errors.
        if (err instanceof NotFoundError || err instanceof BandcampUnavailableError) throw err;
        if (attempt < MAX_RETRIES && isRetryableNetworkError(err)) {
          await sleep(jitterBackoff());
          continue;
        }
        throw new BandcampUnavailableError(`Network error reaching ${url}: ${(err as Error).message}`, {
          cause: err,
        });
      }
      if (response.ok) {
        try {
          return await readBodyText(response, signal);
        } catch (err) {
          if (attempt < MAX_RETRIES && isRetryableNetworkError(err)) {
            await sleep(jitterBackoff());
            continue;
          }
          throw new BandcampUnavailableError(`Failed reading the response from ${url}: ${(err as Error).message}`, {
            cause: err,
          });
        }
      }
      discardBody(response);
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("Retry-After");
        // NaN for a missing or HTTP-date header, which falls back to jitter.
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
        if (retryAfterMs > MAX_RETRY_AFTER_MS) {
          throw new BandcampUnavailableError(
            `Bandcamp is rate-limiting requests and asked to retry after ${retryAfterMs / 1000} seconds (${url})`
          );
        }
        if (attempt < MAX_RETRIES) {
          await sleep(Number.isFinite(retryAfterMs) ? retryAfterMs : jitterBackoff());
          continue;
        }
      }
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(jitterBackoff());
        continue;
      }
      if (response.status === 404) throw new NotFoundError(`Not found: ${url}`);
      throw new BandcampUnavailableError(`Bandcamp returned ${response.status} for ${url}`, {
        status: response.status,
      });
    }
    throw new BandcampUnavailableError(`Exhausted retries for ${url}`);
  } finally {
    releaseSlot();
  }
}

export async function fetchJson(url: string, options: RequestOptions = {}): Promise<unknown> {
  const text = await requestText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new BandcampChallengeError(
      `Bandcamp returned a 200 response for ${url} that wasn't valid JSON — likely a bot-challenge or interstitial page`
    );
  }
}

export async function fetchHtml(url: string, options: RequestOptions = {}): Promise<string> {
  return requestText(url, options);
}
