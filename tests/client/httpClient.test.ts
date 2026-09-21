import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchJson, fetchHtml, MAX_CONCURRENT_REQUESTS, MAX_REDIRECTS } from "../../src/client/httpClient.js";
import { BandcampChallengeError, BandcampUnavailableError, NotFoundError } from "../../src/client/errors.js";

describe("fetchJson", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed JSON on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(fetchJson("https://bandcamp.com/x")).resolves.toEqual({ ok: true });
  });

  it("throws NotFoundError on 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(fetchJson("https://bandcamp.com/x")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws BandcampChallengeError when a 200 body isn't valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>just a moment</html>", { status: 200 })));
    await expect(fetchJson("https://bandcamp.com/x")).rejects.toBeInstanceOf(BandcampChallengeError);
  });

  it("retries once on 429 respecting Retry-After, then succeeds", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return new Response("", { status: 429, headers: { "Retry-After": "0" } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    await expect(fetchJson("https://bandcamp.com/x")).resolves.toEqual({ ok: true });
    expect(call).toBe(2);
  });

  it("fails fast instead of sleeping when Retry-After exceeds the cap", { timeout: 3000 }, async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "3600" } }));
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    const err = await fetchJson("https://bandcamp.com/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BandcampUnavailableError);
    expect((err as Error).message).toMatch(/rate-limiting.*3600/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to jittered backoff when Retry-After is an HTTP-date", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return new Response("", { status: 429, headers: { "Retry-After": "Wed, 21 Oct 2099 07:28:00 GMT" } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    await expect(fetchJson("https://bandcamp.com/x")).resolves.toEqual({ ok: true });
    expect(call).toBe(2);
  });

  it("retries once when the response headers time out", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        call++;
        if (call === 1) {
          // Like undici: headers never arrive, so fetch rejects with the
          // signal's reason (a TimeoutError for AbortSignal.timeout).
          const signal = init!.signal!;
          return new Promise<Response>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    await expect(fetchJson("https://bandcamp.com/x", { timeoutMs: 100 })).resolves.toEqual({ ok: true });
    expect(call).toBe(2);
  });

  it("gives up after exhausting retries on repeated 500s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(fetchJson("https://bandcamp.com/x")).rejects.toBeInstanceOf(BandcampUnavailableError);
  });

  // browse_tag blames a cursor only for a 500, so the status must survive.
  it.each([500, 503])("gives up on a repeated %i with an error carrying that status", async (status) => {
    const fetchMock = vi.fn(async () => new Response("", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await fetchJson("https://bandcamp.com/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BandcampUnavailableError);
    expect((err as BandcampUnavailableError).status).toBe(status);
    expect((err as Error).message).toBe(`Bandcamp returned ${status} for https://bandcamp.com/x`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wraps a network-level failure as BandcampUnavailableError after retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      })
    );
    const err = await fetchJson("https://bandcamp.com/x", { timeoutMs: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BandcampUnavailableError);
    // No HTTP status: nothing was answered.
    expect((err as BandcampUnavailableError).status).toBeUndefined();
  });

  it("caps concurrent in-flight requests", async () => {
    // Mock latency (500ms) is deliberately well above the pacing floor
    // (150ms) so requests genuinely overlap — with the two close together
    // (e.g. 20ms mock latency), pacing alone keeps concurrency near 1 and
    // the cap is never actually exercised, so a passing test wouldn't
    // prove the cap works. Asserting a lower bound too (not just <=)
    // ensures this test would fail if the cap logic were removed.
    let concurrent = 0;
    let maxObserved = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        concurrent++;
        maxObserved = Math.max(maxObserved, concurrent);
        await new Promise((r) => setTimeout(r, 500));
        concurrent--;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    await Promise.all(Array.from({ length: 6 }, () => fetchJson("https://bandcamp.com/x")));
    expect(maxObserved).toBe(MAX_CONCURRENT_REQUESTS);
  });

  it("spaces out concurrent request starts by at least the pacing floor", async () => {
    // Concurrent callers (up to MAX_CONCURRENT_REQUESTS can reach pace()
    // near-simultaneously) must each be spaced at least MIN_REQUEST_SPACING_MS
    // apart, not just eventually all complete. Mock latency is instant here —
    // the point of this test is start-time spacing, not overlap (that's what
    // the concurrency-cap test above already covers).
    const startTimes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        startTimes.push(Date.now());
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    await Promise.all(Array.from({ length: 6 }, () => fetchJson("https://bandcamp.com/x")));
    const sorted = [...startTimes].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(140);
    }
  });
});

describe("fetchHtml", () => {
  it("returns raw text on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>hi</html>", { status: 200 })));
    await expect(fetchHtml("https://bandcamp.com/x")).resolves.toBe("<html>hi</html>");
  });

  it("throws NotFoundError on 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(fetchHtml("https://bandcamp.com/x")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("sends a User-Agent naming bandcamp-mcp at the package.json version", async () => {
    const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
      version: string;
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("<html></html>"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchHtml("https://bandcamp.com/x");
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["User-Agent"]).toBe(
      `Mozilla/5.0 (compatible; bandcamp-mcp/${version}; +https://github.com/Venut-Technologies/bandcamp-mcp)`
    );
  });

  // Headers arrive at once, then the body never finishes (and ignores any
  // abort signal, so only the client's own deadline can end it).
  function stalledBody(): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>partial"));
      },
    });
    return new Response(body, { status: 200 });
  }

  // Headers arrive and the first chunk is read, then the body errors.
  function bodyFailingWith(error: unknown): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>partial"));
      },
      pull(controller) {
        controller.error(error);
      },
    });
    return new Response(body, { status: 200 });
  }

  it("aborts a response body that stalls past the timeout, after one retry", { timeout: 3000 }, async () => {
    const fetchMock = vi.fn(async () => stalledBody());
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    await expect(fetchHtml("https://bandcamp.com/x", { timeoutMs: 200 })).rejects.toBeInstanceOf(
      BandcampUnavailableError
    );
    // Two 200ms deadlines, a 300-800ms backoff and pacing.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once when the response body stalls past the timeout", { timeout: 3000 }, async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => (++call === 1 ? stalledBody() : new Response("ok")));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchHtml("https://bandcamp.com/x", { timeoutMs: 100 })).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once when the connection resets while reading the body", async () => {
    // What undici throws when the socket resets after the headers arrived.
    const reset = new TypeError("terminated", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    let call = 0;
    const fetchMock = vi.fn(async () => (++call === 1 ? bodyFailingWith(reset) : new Response("ok")));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchHtml("https://bandcamp.com/x")).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-network error while reading the body", async () => {
    const fetchMock = vi.fn(async () => bodyFailingWith(new Error("boom")));
    vi.stubGlobal("fetch", fetchMock);
    const err = await fetchHtml("https://bandcamp.com/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BandcampUnavailableError);
    expect((err as Error).message).toMatch(/Failed reading the response.*boom/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // One retry on any network-level failure: a timeout, a 5xx, a reset or
  // closed socket, a DNS or TLS error. Every transport-level failure undici
  // surfaces carries a string `cause.code`; these are the real Node 22 shapes.
  const transportFailures: Array<[string, string]> = [
    ["UND_ERR_SOCKET", "other side closed"],
    ["UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"],
    ["ECONNREFUSED", "connect ECONNREFUSED 1.2.3.4:443"],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN bandcamp.com"],
    ["CERT_HAS_EXPIRED", "certificate has expired"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames"],
    ["EPROTO", "write EPROTO"],
  ];

  it.each(transportFailures)("retries once when the request fails with %s", async (code, message) => {
    const failure = new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      if (++call === 1) throw failure;
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchHtml("https://x.bandcamp.com/music")).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The keep-alive race against a CDN: undici does not retry it itself, so
  // without this the spec's retry budget never absorbs a routine transient.
  it("retries once when the socket closes while reading the body", async () => {
    const closed = new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    let call = 0;
    const fetchMock = vi.fn(async () => (++call === 1 ? bodyFailingWith(closed) : new Response("ok")));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchHtml("https://x.bandcamp.com/music")).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a request failure that carries no transport code", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("boom");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchHtml("https://x.bandcamp.com/music")).rejects.toBeInstanceOf(BandcampUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("redirects", () => {
  function redirectTo(status: number, location?: string): Response {
    return new Response(null, { status, headers: location === undefined ? {} : { Location: location } });
  }

  // Serves each URL from its route; any other URL fails the request loudly.
  function stubRoutes(routes: Record<string, () => Response>) {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const route = routes[String(input)];
      if (!route) throw new Error(`unexpected fetch of ${String(input)}`);
      return route();
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function fetchedUrls(fetchMock: ReturnType<typeof stubRoutes>): string[] {
    return fetchMock.mock.calls.map(([input]) => String(input));
  }

  it("follows a redirect to another *.bandcamp.com URL, pacing the hop, and returns the final body", async () => {
    const startTimes: number[] = [];
    const fetchMock = stubRoutes({
      "https://old-name.bandcamp.com/album/x": () => {
        startTimes.push(Date.now());
        return redirectTo(301, "https://new-name.bandcamp.com/album/x");
      },
      "https://new-name.bandcamp.com/album/x": () => {
        startTimes.push(Date.now());
        return new Response("<html>moved</html>", { status: 200 });
      },
    });
    await expect(fetchHtml("https://old-name.bandcamp.com/album/x")).resolves.toBe("<html>moved</html>");
    expect(fetchedUrls(fetchMock)).toEqual([
      "https://old-name.bandcamp.com/album/x",
      "https://new-name.bandcamp.com/album/x",
    ]);
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(140);
  });

  it("resolves a relative Location against the current URL", async () => {
    // Artist pages are fetched at /music, so resolution must work from a non-root path.
    const fetchMock = stubRoutes({
      "https://artist.bandcamp.com/music": () => redirectTo(303, "/album/x"),
      "https://artist.bandcamp.com/album/x": () => new Response("<html>album</html>", { status: 200 }),
    });
    await expect(fetchHtml("https://artist.bandcamp.com/music")).resolves.toBe("<html>album</html>");
    expect(fetchedUrls(fetchMock)).toEqual([
      "https://artist.bandcamp.com/music",
      "https://artist.bandcamp.com/album/x",
    ]);
  });

  it.each(["https://evil.example.com/", "http://127.0.0.1/"])(
    "refuses a redirect to %s with NotFoundError and never fetches it",
    async (target) => {
      const fetchMock = stubRoutes({ "https://artist.bandcamp.com/": () => redirectTo(302, target) });
      const err = await fetchHtml("https://artist.bandcamp.com/").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toMatch(/outside bandcamp\.com/);
      expect(fetchedUrls(fetchMock)).toEqual(["https://artist.bandcamp.com/"]);
    }
  );

  it("reports a nonexistent artist (303 to bandcamp.com/signup) as NotFoundError without fetching the signup page", async () => {
    // Bandcamp's real answer for an unclaimed subdomain (verified live 2026-09-19).
    const fetchMock = stubRoutes({
      "https://nonexistentartist-zq91x.bandcamp.com/": () =>
        redirectTo(303, "https://bandcamp.com/signup?new_domain=nonexistentartist-zq91x"),
    });
    const err = await fetchHtml("https://nonexistentartist-zq91x.bandcamp.com/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toMatch(/no such Bandcamp artist/i);
    expect(fetchedUrls(fetchMock)).toEqual(["https://nonexistentartist-zq91x.bandcamp.com/"]);
  });

  it("gives up with BandcampUnavailableError after MAX_REDIRECTS hops", async () => {
    const fetchMock = stubRoutes({
      "https://a.bandcamp.com/": () => redirectTo(302, "https://b.bandcamp.com/"),
      "https://b.bandcamp.com/": () => redirectTo(302, "https://a.bandcamp.com/"),
    });
    await expect(fetchHtml("https://a.bandcamp.com/")).rejects.toBeInstanceOf(BandcampUnavailableError);
    // The original request plus exactly MAX_REDIRECTS followed hops, no retry.
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("throws BandcampUnavailableError on a redirect without a Location header", async () => {
    const fetchMock = stubRoutes({ "https://artist.bandcamp.com/": () => redirectTo(302) });
    await expect(fetchHtml("https://artist.bandcamp.com/")).rejects.toBeInstanceOf(BandcampUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 301, method: "POST", body: '{"q":1}' },
    { status: 302, method: "POST", body: '{"q":1}' },
    { status: 303, method: "GET", body: undefined },
    { status: 307, method: "POST", body: '{"q":1}' },
    { status: 308, method: "POST", body: '{"q":1}' },
  ])("a $status redirect re-sends the request as $method", async ({ status, method, body }) => {
    const fetchMock = stubRoutes({
      "https://bandcamp.com/api/old": () => redirectTo(status, "https://bandcamp.com/api/new"),
      "https://bandcamp.com/api/new": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    await expect(fetchJson("https://bandcamp.com/api/old", { method: "POST", body: { q: 1 } })).resolves.toEqual({
      ok: true,
    });
    const hopInit = fetchMock.mock.calls[1][1];
    expect(hopInit?.method).toBe(method);
    expect(hopInit?.body).toBe(body);
    expect((hopInit?.headers as Record<string, string>)["Content-Type"]).toBe(
      body === undefined ? undefined : "application/json"
    );
  });

  it('makes every fetch call with redirect: "manual", including retries and hops', async () => {
    let call = 0;
    const fetchMock = stubRoutes({
      "https://a.bandcamp.com/": () =>
        ++call === 1
          ? new Response("", { status: 429, headers: { "Retry-After": "0" } })
          : redirectTo(302, "https://b.bandcamp.com/"),
      "https://b.bandcamp.com/": () => new Response("<html>ok</html>", { status: 200 }),
    });
    await expect(fetchHtml("https://a.bandcamp.com/")).resolves.toBe("<html>ok</html>");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("manual");
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
