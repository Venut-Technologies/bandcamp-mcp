import { describe, it, expect, vi, afterEach } from "vitest";
import { getAlbum as realGetAlbum } from "../src/client/bandcampClient.js";
import {
  BandcampChallengeError,
  BandcampShapeChangedError,
  BandcampUnavailableError,
  NotFoundError,
} from "../src/client/errors.js";
import { AlbumSchema, ArtistSchema, SearchResultSchema, TrackDetailSchema } from "../src/client/types.js";
import type { Album, Artist, SearchResult, TrackDetail } from "../src/client/types.js";
import {
  SMOKE_CHECKS,
  classifyError,
  extractPageTitle,
  formatSummary,
  recordResponses,
  runSmoke,
  type CheckResult,
  type SmokeClient,
} from "../scripts/smoke-lib.js";

// Offline: checks run against a fake client built from the real schemas, or
// the real client over a stubbed fetch. The live run is `npm run smoke-test`.

const searchResults: SearchResult[] = SearchResultSchema.array().parse([
  { type: "album", name: "Cathedral", artist: "John Carpenter", slug: "johncarpentermusic/album/cathedral" },
]);

function album(overrides: Partial<Album>): Album {
  return AlbumSchema.parse({
    title: "Cathedral",
    artist: "John Carpenter",
    releaseDate: "20 Sep 2026 00:00:00 GMT",
    tracks: [
      { title: "Primeval", artist: "John Carpenter", position: 1, durationSeconds: 200, slug: "johncarpentermusic/track/primeval" },
    ],
    tags: ["electronic"],
    description: { text: "", truncated: false },
    priceText: "9",
    priceCurrency: "USD",
    isNameYourPrice: false,
    label: "Sacred Bones Records",
    ...overrides,
  });
}

const ALBUMS: Record<string, Album> = {
  "johncarpentermusic/album/cathedral": album({}),
  "sacredbonesrecords/album/todo-muere-volume-3": album({
    title: "Todo Muere Vol. 3",
    artist: "Various Artists",
    tracks: [
      { title: "Night", artist: "John Carpenter", position: 1, durationSeconds: 313, slug: null },
      { title: "Ruins", artist: "Zola Jesus", position: 2, durationSeconds: null, slug: null },
    ],
    isNameYourPrice: true,
  }),
  "kiarangl/album/gloom-garden": album({ title: "Gloom Garden", artist: "kiarangl", isNameYourPrice: true }),
};

const artist: Artist = ArtistSchema.parse({
  name: "Sacred Bones Records",
  location: "Brooklyn, New York",
  bio: { text: "", truncated: false },
  discography: [{ title: "Cathedral", slug: "johncarpentermusic/album/cathedral", type: "album", artist: "John Carpenter" }],
  discographyTotal: 1,
  discographyTruncated: false,
});

const track: TrackDetail = TrackDetailSchema.parse({
  title: "Primeval",
  artist: "John Carpenter",
  durationSeconds: 200,
  slug: "johncarpentermusic/track/primeval",
  album: { title: "Cathedral", slug: "johncarpentermusic/album/cathedral" },
  tags: [],
  description: { text: "", truncated: false },
});

function passingClient() {
  return {
    search: vi.fn(async () => searchResults),
    getAlbum: vi.fn(async (slug: string) => ALBUMS[slug] ?? Promise.reject(new NotFoundError(`no fixture for ${slug}`))),
    getArtist: vi.fn(async () => artist),
    getTrack: vi.fn(async () => track),
    browseTag: vi.fn(async () => ({ results: searchResults, nextCursor: "cursor-1" })),
  } satisfies SmokeClient;
}

// The result of one named check when the client is patched with `overrides`.
async function resultOf(name: string, overrides: Partial<SmokeClient>): Promise<CheckResult> {
  const check = SMOKE_CHECKS.find((c) => c.name === name);
  if (!check) throw new Error(`no check named ${name}`);
  const { results } = await runSmoke([check], { ...passingClient(), ...overrides });
  return results[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SMOKE_CHECKS", () => {
  it("covers all five client functions against structurally different targets, and passes on healthy data", async () => {
    const client = passingClient();
    const summary = await runSmoke(SMOKE_CHECKS, client, { now: () => new Date("2026-09-19T06:17:00.000Z") });

    expect(summary).toEqual({
      timestamp: "2026-09-19T06:17:00.000Z",
      ok: true,
      results: [
        { name: "search", target: 'search "carpenter" (type all)', ok: true },
        { name: "album (standard)", target: "https://johncarpentermusic.bandcamp.com/album/cathedral", ok: true },
        {
          name: "album (various-artists)",
          target: "https://sacredbonesrecords.bandcamp.com/album/todo-muere-volume-3",
          ok: true,
        },
        { name: "album (name-your-price)", target: "https://kiarangl.bandcamp.com/album/gloom-garden", ok: true },
        { name: "artist (label)", target: "https://sacredbonesrecords.bandcamp.com/music", ok: true },
        { name: "track", target: "https://johncarpentermusic.bandcamp.com/track/primeval", ok: true },
        { name: "browse (tag, top)", target: "discover tag=electronic sort=top", ok: true },
        { name: "browse (unfiltered, new)", target: "discover tag=(none) sort=new", ok: true },
      ],
    });
    expect(client.search.mock.calls).toEqual([["carpenter", "all"]]);
    expect(client.getAlbum.mock.calls).toEqual([
      ["johncarpentermusic/album/cathedral"],
      ["sacredbonesrecords/album/todo-muere-volume-3"],
      ["kiarangl/album/gloom-garden"],
    ]);
    expect(client.getArtist.mock.calls).toEqual([["sacredbonesrecords"]]);
    expect(client.getTrack.mock.calls).toEqual([["johncarpentermusic/track/primeval"]]);
    expect(client.browseTag.mock.calls).toEqual([
      ["electronic", "top"],
      [null, "new"],
    ]);
  });

  // A normalizer that silently drops everything must fail the canary, not pass it.
  it.each<[string, Partial<SmokeClient>, string]>([
    ["search", { search: async () => [] }, "search returned no results"],
    [
      "search",
      { search: async () => searchResults.map((r) => ({ ...r, slug: null })) },
      "no search result has a slug",
    ],
    ["album (standard)", { getAlbum: async () => ({ ...album({}), tracks: [] }) }, "album has no tracks"],
    ["album (standard)", { getAlbum: async () => ({ ...album({}), title: "" }) }, "album title is empty"],
    [
      "album (various-artists)",
      { getAlbum: async () => album({}) },
      "expected at least 2 distinct track artists, got 1",
    ],
    [
      "album (name-your-price)",
      { getAlbum: async () => album({ isNameYourPrice: false }) },
      "expected isNameYourPrice to be true, got false",
    ],
    ["artist (label)", { getArtist: async () => ({ ...artist, discography: [] }) }, "discography is empty"],
    [
      "artist (label)",
      { getArtist: async () => ({ ...artist, discography: artist.discography.map((d) => ({ ...d, slug: null })) }) },
      "no discography entry has a slug",
    ],
    [
      "artist (label)",
      { getArtist: async () => ({ ...artist, discography: artist.discography.map((d) => ({ ...d, artist: null })) }) },
      "no discography entry names its artist",
    ],
    ["track", { getTrack: async () => ({ ...track, title: "" }) }, "track title is empty"],
    ["track", { getTrack: async () => ({ ...track, album: null }) }, "track has no album"],
    ["browse (tag, top)", { browseTag: async () => ({ results: [], nextCursor: "c" }) }, "browse returned no results"],
    [
      "browse (tag, top)",
      { browseTag: async () => ({ results: searchResults, nextCursor: null }) },
      "browse returned no nextCursor",
    ],
    [
      "browse (unfiltered, new)",
      { browseTag: async () => ({ results: [], nextCursor: null }) },
      "browse returned no results",
    ],
  ])("%s fails as an assertion when the data breaks a pass condition (%#)", async (name, overrides, problem) => {
    const result = await resultOf(name, overrides);
    expect(result).toMatchObject({ name, ok: false, kind: "assertion", errorName: "SmokeAssertionError" });
    expect(result.ok === false && result.message).toContain(problem);
  });

  it("reports every broken pass condition of a check, not just the first", async () => {
    const result = await resultOf("track", { getTrack: async () => ({ ...track, title: "", album: null }) });
    expect(result.ok === false && result.message).toBe("track title is empty; track has no album");
  });
});

describe("classifyError", () => {
  it.each<[string, unknown, number | undefined, string]>([
    ["a challenge page", new BandcampChallengeError("interstitial"), undefined, "challenge"],
    ["confirmed drift", new BandcampShapeChangedError("drift"), undefined, "shape-changed"],
    ["a missing page", new NotFoundError("gone"), undefined, "not-found"],
    ["HTTP 403", new BandcampUnavailableError("blocked", { status: 403 }), 403, "challenge"],
    ["HTTP 429", new BandcampUnavailableError("slow down", { status: 429 }), 429, "challenge"],
    ["HTTP 500", new BandcampUnavailableError("oops", { status: 500 }), 500, "unavailable"],
    ["a network error", new BandcampUnavailableError("ECONNRESET"), undefined, "unavailable"],
    // A 429 whose Retry-After is too long carries no status on the error; the
    // status of the response actually seen still marks it.
    ["a status-less error after a 429", new BandcampUnavailableError("retry after 60s"), 429, "challenge"],
    ["a status-less error after a 303", new BandcampUnavailableError("timeout"), 303, "unavailable"],
    ["any other error", new TypeError("bug"), undefined, "other"],
    ["a thrown non-Error", "boom", undefined, "other"],
  ])("classifies %s", (_label, err, httpStatus, kind) => {
    expect(classifyError(err, httpStatus)).toBe(kind);
  });
});

describe("runSmoke", () => {
  it("records the error name, message and HTTP status of a failing check and keeps going", async () => {
    const client = passingClient();
    client.search.mockRejectedValueOnce(
      new BandcampUnavailableError("Bandcamp returned 403 for https://bandcamp.com/api/x", { status: 403 })
    );
    const summary = await runSmoke(SMOKE_CHECKS.slice(0, 2), client);

    expect(summary.ok).toBe(false);
    expect(summary.results).toEqual([
      {
        name: "search",
        target: 'search "carpenter" (type all)',
        ok: false,
        kind: "challenge",
        errorName: "BandcampUnavailableError",
        message: "Bandcamp returned 403 for https://bandcamp.com/api/x",
        httpStatus: 403,
      },
      { name: "album (standard)", target: "https://johncarpentermusic.bandcamp.com/album/cathedral", ok: true },
    ]);
  });

  it("adds the status and page title of the last response seen during the failing check", async () => {
    const client = passingClient();
    client.getAlbum.mockRejectedValueOnce(new BandcampChallengeError("interstitial"));
    const takeLastResponse = vi.fn(() => ({ status: 200, pageTitle: Promise.resolve("Just a moment...") }));
    const { results } = await runSmoke(SMOKE_CHECKS.slice(1, 2), client, { takeLastResponse });

    expect(results[0]).toMatchObject({ ok: false, kind: "challenge", httpStatus: 200, pageTitle: "Just a moment..." });
  });

  it("never blames a failing check on a response from before it started", async () => {
    const recorder = recordResponses(
      async () => new Response("<title>Earlier page</title>", { status: 500, headers: { "content-type": "text/html" } })
    );
    await recorder.fetch("https://bandcamp.com/earlier");
    const client = passingClient();
    // Fails before sending anything.
    client.getTrack.mockRejectedValueOnce(new Error("Invalid track slug"));
    const { results } = await runSmoke(SMOKE_CHECKS.slice(5, 6), client, { takeLastResponse: recorder.takeLast });

    expect(results[0]).toEqual({
      name: "track",
      target: "https://johncarpentermusic.bandcamp.com/track/primeval",
      ok: false,
      kind: "other",
      errorName: "Error",
      message: "Invalid track slug",
    });
  });

  it("runs checks one at a time", async () => {
    const client = passingClient();
    let releaseSearch!: (value: SearchResult[]) => void;
    client.search.mockImplementationOnce(() => new Promise((resolve) => (releaseSearch = resolve)));
    const run = runSmoke(SMOKE_CHECKS.slice(0, 2), client);

    await vi.waitFor(() => expect(client.search).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.getAlbum).not.toHaveBeenCalled();
    releaseSearch(searchResults);
    expect((await run).ok).toBe(true);
    expect(client.getAlbum).toHaveBeenCalledOnce();
  });

  it("gives up on a check that never settles and moves on to the next one", async () => {
    const client = passingClient();
    client.search.mockImplementationOnce(() => new Promise(() => {}));
    const { results } = await runSmoke(SMOKE_CHECKS.slice(0, 2), client, { checkTimeoutMs: 30 });

    expect(results[0]).toMatchObject({
      ok: false,
      kind: "other",
      errorName: "SmokeTimeoutError",
      message: "check did not finish within 30 ms",
    });
    expect(results[1].ok).toBe(true);
  });
});

describe("formatSummary", () => {
  it("prints one line per check with the failure details", () => {
    const text = formatSummary({
      timestamp: "2026-09-19T06:17:00.000Z",
      ok: false,
      results: [
        { name: "search", target: 'search "carpenter" (type all)', ok: true },
        {
          name: "artist (label)",
          target: "https://sacredbonesrecords.bandcamp.com/music",
          ok: false,
          kind: "challenge",
          errorName: "BandcampUnavailableError",
          message: "Bandcamp returned 403",
          httpStatus: 403,
          pageTitle: "Access denied",
        },
        {
          name: "track",
          target: "https://johncarpentermusic.bandcamp.com/track/primeval",
          ok: false,
          kind: "assertion",
          errorName: "SmokeAssertionError",
          message: "track has no album",
        },
      ],
    });

    expect(text).toBe(
      [
        "Bandcamp smoke test — 2026-09-19T06:17:00.000Z",
        '- [OK] search — search "carpenter" (type all)',
        '- [FAIL] artist (label) — https://sacredbonesrecords.bandcamp.com/music — challenge: BandcampUnavailableError (HTTP 403, page title "Access denied"): Bandcamp returned 403',
        "- [FAIL] track — https://johncarpentermusic.bandcamp.com/track/primeval — assertion: SmokeAssertionError: track has no album",
        "3 checks: 1 passed, 2 failed",
      ].join("\n")
    );
  });
});

describe("extractPageTitle", () => {
  it("returns the decoded, whitespace-collapsed <title>", () => {
    expect(extractPageTitle("<html><head><title>\n  Cathedral | John Carpenter &amp; Friends\n</title>")).toBe(
      "Cathedral | John Carpenter & Friends"
    );
  });

  it("returns undefined when there is no title or it is blank", () => {
    expect(extractPageTitle('{"results":[]}')).toBeUndefined();
    expect(extractPageTitle("<title>  </title>")).toBeUndefined();
  });

  it("caps a very long title", () => {
    expect(extractPageTitle(`<title>${"x".repeat(1000)}</title>`)).toHaveLength(200);
  });
});

describe("recordResponses", () => {
  it("records the status and page title of an HTML response and leaves its body readable", async () => {
    const recorder = recordResponses(
      async () =>
        new Response("<html><head><title>Access denied</title></head></html>", {
          status: 403,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
    );
    const response = await recorder.fetch("https://bandcamp.com/");

    expect(await response.text()).toContain("Access denied");
    const observed = recorder.takeLast();
    expect(observed?.status).toBe(403);
    expect(await observed?.pageTitle).toBe("Access denied");
    // takeLast hands each response over once.
    expect(recorder.takeLast()).toBeUndefined();
  });

  it("reads the page title even when the caller discards the body", async () => {
    const recorder = recordResponses(
      async () =>
        new Response("<title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html" } })
    );
    const response = await recorder.fetch("https://bandcamp.com/");
    await response.body?.cancel();

    expect(await recorder.takeLast()?.pageTitle).toBe("Just a moment...");
  });

  it("records no title for a non-HTML response", async () => {
    const recorder = recordResponses(
      async () => new Response('{"results":[]}', { status: 200, headers: { "content-type": "application/json" } })
    );
    await recorder.fetch("https://bandcamp.com/api/");
    const observed = recorder.takeLast();

    expect(observed?.status).toBe(200);
    expect(await observed?.pageTitle).toBeUndefined();
  });

  // End to end through the real client: the recorder sits where fetch is,
  // exactly as the runner installs it.
  it.each<[string, number, string, string, string]>([
    ["a 403 block page", 403, "Access denied", "BandcampUnavailableError", "challenge"],
    ["a 200 interstitial", 200, "Just a moment...", "BandcampChallengeError", "challenge"],
  ])("classifies %s met by the real client as a challenge with its status and title", async (_l, status, title, errorName, kind) => {
    const recorder = recordResponses(
      async () =>
        new Response(`<!DOCTYPE html><html><head><title>${title}</title></head><body>Just a moment</body></html>`, {
          status,
          headers: { "content-type": "text/html" },
        })
    );
    vi.stubGlobal("fetch", recorder.fetch);
    const check = SMOKE_CHECKS.find((c) => c.name === "album (standard)")!;
    const { results } = await runSmoke([check], { ...passingClient(), getAlbum: realGetAlbum }, {
      takeLastResponse: recorder.takeLast,
    });

    expect(results[0]).toMatchObject({ ok: false, kind, errorName, httpStatus: status, pageTitle: title });
  });
});
