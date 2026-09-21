import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// Unit level: httpClient is mocked, every response body is a real captured
// fixture (tests/fixtures), and no test touches the network.
vi.mock("../../src/client/httpClient.js", () => ({
  fetchJson: vi.fn(),
  fetchHtml: vi.fn(),
}));

import { fetchJson, fetchHtml } from "../../src/client/httpClient.js";
import { search, browseTag, getAlbum, getArtist, getTrack } from "../../src/client/bandcampClient.js";
import {
  BandcampChallengeError,
  BandcampShapeChangedError,
  BandcampUnavailableError,
  NotFoundError,
} from "../../src/client/errors.js";

const SEARCH_URL = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic";
const DISCOVER_URL = "https://bandcamp.com/api/discover/1/discover_web";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf-8");
const jsonFixture = (name: string): { auto: { results: unknown[] } } => JSON.parse(fixture(name));

const searchFixture = jsonFixture("search-vesper.json");
const bandsFixture = jsonFixture("search-paper-kite-bands.json");
const tracksFixture = jsonFixture("search-glass-meridian-tracks.json");
const browseFixture = JSON.parse(fixture("browse-electronic-top.json"));
const albumHtml = fixture("album-nightglass.html");
const artistHtml = fixture("artist-paperkite.html");
const vesperMusicHtml = fixture("artist-marlowvesper-music.html");
const landingAlbumHtml = fixture("artist-landing-album.html");
const fanStubHtml = fixture("artist-fan-stub.html");
const trackOnAlbumHtml = fixture("track-glass-meridian.html");
const singleHtml = fixture("track-slow-lantern.html");
const challengeHtml =
  `<!DOCTYPE html><html><head><title>Just a moment...</title></head>` +
  `<body><div id="challenge-running"></div></body></html>`;

// Body passed to the n-th fetchJson call (httpClient stringifies it itself).
function sentBody(call = 0): Record<string, unknown> {
  const [, options] = vi.mocked(fetchJson).mock.calls[call];
  return (options as { body: Record<string, unknown> }).body;
}

beforeEach(() => {
  // Resets call history and queued mockResolvedValueOnce values, so each
  // "never fetched" assertion only sees its own test's calls.
  vi.resetAllMocks();
});

describe("search", () => {
  it("POSTs the query to the search endpoint and returns normalized results", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce(searchFixture);
    const results = await search("vesper", "album");
    expect(fetchJson).toHaveBeenCalledWith(SEARCH_URL, expect.objectContaining({ method: "POST" }));
    expect(sentBody()).toEqual({ search_text: "vesper", search_filter: "a", full_page: true, fan_id: null });
    expect(results).toHaveLength(50);
    expect(results[0]).toEqual({
      type: "album",
      name: "TRIPTYCH",
      artist: "Vesper Brut",
      slug: "vesperbrut/album/triptych",
    });
  });

  it.each([
    ["all", ""],
    ["album", "a"],
    ["artist", "b"],
    ["label", "b"],
    ["track", "t"],
  ] as const)("sends search_filter for type %s as %j", async (type, filter) => {
    vi.mocked(fetchJson).mockResolvedValueOnce({ auto: { results: [] } });
    await search("x", type);
    expect(sentBody().search_filter).toBe(filter);
  });

  it("searches all types when no type is given", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce({ auto: { results: [] } });
    await search("x");
    expect(sentBody().search_filter).toBe("");
  });

  // Artists and labels share filter "b"; only is_label tells them apart.
  it("keeps only artists or only labels from the real band results", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce(bandsFixture);
    expect(await search("paper kite", "artist")).toEqual([
      { type: "artist", name: "Paper Kite", artist: null, slug: "thepaperkite" },
    ]);
    vi.mocked(fetchJson).mockResolvedValueOnce(bandsFixture);
    expect(await search("paper kite", "label")).toEqual([
      { type: "label", name: "Paper Kite Records", artist: null, slug: "paperkiterecords" },
    ]);
  });

  it("returns only the requested type from a mixed response, and everything for 'all'", async () => {
    const mixed = {
      auto: {
        results: [
          ...bandsFixture.auto.results,
          searchFixture.auto.results[0],
          tracksFixture.auto.results[0],
          { type: "f", name: "Some Fan" },
        ],
      },
    };
    const namesFor = async (type?: "all" | "album" | "artist" | "track" | "label") => {
      vi.mocked(fetchJson).mockResolvedValueOnce(mixed);
      return (await search("q", type)).map((r) => `${r.type}:${r.name}`);
    };
    expect(await namesFor("album")).toEqual(["album:TRIPTYCH"]);
    expect(await namesFor("track")).toEqual(["track:Glass Meridian (Aster Vane Remix)"]);
    expect(await namesFor("artist")).toEqual(["artist:Paper Kite"]);
    expect(await namesFor("label")).toEqual(["label:Paper Kite Records"]);
    expect(await namesFor("all")).toEqual([
      "label:Paper Kite Records",
      "artist:Paper Kite",
      "album:TRIPTYCH",
      "track:Glass Meridian (Aster Vane Remix)",
    ]);
  });

  it("fails closed on a response without auto.results", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce({ error: true });
    await expect(search("x")).rejects.toThrow(BandcampShapeChangedError);
  });
});

describe("browseTag", () => {
  it("POSTs the tag and sort to the discover endpoint and returns a page", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce(browseFixture);
    const page = await browseTag("electronic", "top");
    expect(fetchJson).toHaveBeenCalledWith(DISCOVER_URL, expect.objectContaining({ method: "POST" }));
    expect(sentBody()).toEqual({
      category_id: 0,
      tag_norm_names: ["electronic"],
      geoname_id: 0,
      slice: "top",
      time_facet_id: null,
      cursor: null,
      size: 20,
      include_result_types: ["a"],
    });
    expect(page.results).toHaveLength(20);
    expect(page.results[0]).toEqual({
      type: "album",
      name: "Slipstream",
      artist: "Marena Kite",
      slug: "marenakite/album/slipstream",
    });
    expect(page.nextCursor).toBe("AoMIQjvdcXii/cLFoAMrYTExMzEwODUxNzk=");
  });

  it("sends an empty tag_norm_names for an unfiltered listing", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce(browseFixture);
    await browseTag(null, "new");
    expect(sentBody()).toMatchObject({ tag_norm_names: [], slice: "new" });
  });

  it("passes a cursor through verbatim", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce(browseFixture);
    await browseTag("electronic", "top", "AoMIQjvdcXii/cLFoAMrYTExMzEwODUxNzk=");
    expect(sentBody().cursor).toBe("AoMIQjvdcXii/cLFoAMrYTExMzEwODUxNzk=");
  });
});

describe("getAlbum", () => {
  it("fetches the URL built from the slug and returns a normalized Album", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(albumHtml);
    const album = await getAlbum("marlowvesper/album/nightglass");
    expect(fetchHtml).toHaveBeenCalledWith("https://marlowvesper.bandcamp.com/album/nightglass");
    expect(album).toMatchObject({
      title: "Nightglass",
      artist: "Marlow Vesper",
      label: "Paper Kite Records",
      priceText: "9",
      priceCurrency: "USD",
      tags: ["alternative", "electronic", "new age", "prog-rock", "rock", "Los Angeles"],
    });
    expect(album.tracks).toHaveLength(14);
    expect(album.description.text).toMatch(/^A night drive through empty streets\./);
  });

  it("rejects a bot-challenge page", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(challengeHtml);
    await expect(getAlbum("marlowvesper/album/nightglass")).rejects.toThrow(BandcampChallengeError);
  });
});

describe("getArtist", () => {
  it("fetches the artist's /music page and returns the capped catalog of a real label", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(artistHtml);
    const artist = await getArtist("paperkiterecords");
    expect(fetchHtml).toHaveBeenCalledWith("https://paperkiterecords.bandcamp.com/music");
    expect(artist).toMatchObject({
      name: "Paper Kite Records",
      location: "Rotterdam",
      bio: { text: "Records for restless listeners", truncated: false },
      discographyTotal: 400,
      discographyTruncated: true,
    });
    expect(artist.discography).toHaveLength(100);
    expect(artist.discography.find((item) => item.title === "Nightglass")).toEqual({
      title: "Nightglass",
      slug: "marlowvesper/album/nightglass",
      type: "album",
      artist: "Marlow Vesper",
    });
  });

  it("resolves a single artist's relative links against its own subdomain", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(vesperMusicHtml);
    const artist = await getArtist("MarlowVesper");
    expect(fetchHtml).toHaveBeenCalledWith("https://marlowvesper.bandcamp.com/music");
    expect(artist).toMatchObject({ name: "Marlow Vesper", discographyTotal: 26, discographyTruncated: false });
    expect(artist.discography[1]).toEqual({
      title: "Nightglass",
      slug: "marlowvesper/album/nightglass",
      type: "album",
      artist: null,
    });
  });

  // paleledger.bandcamp.com/music answers 303 to its only album; httpClient
  // follows it, so getArtist receives that album page.
  it("lists the release a /music redirect landed on as the whole discography", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(landingAlbumHtml);
    const artist = await getArtist("paleledger");
    expect(artist).toMatchObject({
      name: "PALE LEDGER",
      location: "Tallinn",
      discography: [
        {
          title: "SONGS FOR THE NIGHT SHIFT",
          slug: "paleledger/album/songs-for-the-night-shift",
          type: "album",
          artist: "Adaeze Hart, Juno Ferrer, kalaya",
        },
      ],
      discographyTotal: 1,
      discographyTruncated: false,
    });
  });

  it("rejects a bot-challenge page", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(challengeHtml);
    await expect(getArtist("paperkiterecords")).rejects.toThrow(BandcampChallengeError);
  });

  // A subdomain held by a fan/listener account is a real, normal Bandcamp page
  // type reachable straight from bandcamp_search (or from guessing a
  // subdomain), so it must read as "no artist here", never as drift.
  it("reports a fan/stub profile page as not found, not as shape drift", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(fanStubHtml);
    await expect(getArtist("quietcollector")).rejects.toThrow(NotFoundError);
    vi.mocked(fetchHtml).mockResolvedValueOnce(fanStubHtml);
    await expect(getArtist("quietcollector")).rejects.toThrow(/fan or placeholder profile/);
  });

  it("reports a page without the artist sidebar as shape drift, not as a missing artist", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(artistHtml.replace('id="band-name-location"', 'id="renamed"'));
    await expect(getArtist("paperkiterecords")).rejects.toThrow(BandcampShapeChangedError);
  });

  // Fail closed: a drifted release grid must never read as "no releases"
  // (the real page lists 26).
  it("reports a renamed #music-grid as shape drift, not as an empty discography", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(vesperMusicHtml.replace('id="music-grid"', 'id="release-grid"'));
    await expect(getArtist("marlowvesper")).rejects.toThrow(BandcampShapeChangedError);
  });

  it("reports a grid whose entries no longer parse as shape drift", async () => {
    const drifted = vesperMusicHtml
      .replace(/<p class="title">/g, '<p class="release-name">')
      .replace(/\sdata-client-items="[^"]*"/, "");
    expect(drifted).toMatch(/id="music-grid"/);
    vi.mocked(fetchHtml).mockResolvedValueOnce(drifted);
    await expect(getArtist("marlowvesper")).rejects.toThrow(BandcampShapeChangedError);
  });

  it("reports a /music redirect landing page without release JSON-LD as shape drift", async () => {
    const drifted = landingAlbumHtml.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
    expect(drifted).not.toMatch(/ld\+json/);
    vi.mocked(fetchHtml).mockResolvedValueOnce(drifted);
    await expect(getArtist("paleledger")).rejects.toThrow(BandcampShapeChangedError);
  });

  it("returns an empty discography only for a present grid that lists nothing", async () => {
    const empty = vesperMusicHtml.replace(/<ol id="music-grid"[\s\S]*?<\/ol>/, '<ol id="music-grid"></ol>');
    expect(empty).not.toMatch(/data-client-items/);
    vi.mocked(fetchHtml).mockResolvedValueOnce(empty);
    const artist = await getArtist("marlowvesper");
    expect(artist).toMatchObject({
      name: "Marlow Vesper",
      discography: [],
      discographyTotal: 0,
      discographyTruncated: false,
    });
  });
});

describe("getTrack", () => {
  it("returns a TrackDetail for a track on an album, linking the album", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(trackOnAlbumHtml);
    const track = await getTrack("marlowvesper/track/glass-meridian");
    expect(fetchHtml).toHaveBeenCalledWith("https://marlowvesper.bandcamp.com/track/glass-meridian");
    expect(track).toMatchObject({
      title: "Glass Meridian",
      artist: "Marlow Vesper",
      durationSeconds: 313,
      slug: "marlowvesper/track/glass-meridian",
      album: { title: "Nightglass", slug: "marlowvesper/album/nightglass" },
    });
  });

  it("returns a TrackDetail with a slug-less album for a standalone single", async () => {
    vi.mocked(fetchHtml).mockResolvedValueOnce(singleHtml);
    const track = await getTrack("cobaltheron/track/slow-lantern");
    expect(fetchHtml).toHaveBeenCalledWith("https://cobaltheron.bandcamp.com/track/slow-lantern");
    expect(track).toMatchObject({
      title: "Slow Lantern",
      artist: "Cobalt Heron",
      album: { title: "Slow Lantern", slug: null },
    });
    expect(track.description.text).toBe("A short record about long journeys: trains, ferries, and waiting rooms.");
  });
});

// Slugs are validated before any URL is built or fetched (spec 7).
describe("malformed slugs never reach the network", () => {
  it.each([
    ["getAlbum", () => getAlbum("not-a-valid-slug")],
    ["getAlbum", () => getAlbum("marlowvesper/track/glass-meridian")],
    ["getAlbum", () => getAlbum("https://evil.example.com/album/x")],
    ["getAlbum", () => getAlbum("evil.example.com#/album/x")],
    ["getTrack", () => getTrack("marlowvesper/album/nightglass")],
    ["getTrack", () => getTrack("../../track/x")],
    ["getArtist", () => getArtist("evil.example.com")],
    ["getArtist", () => getArtist("paperkiterecords/music")],
    ["getArtist", () => getArtist("")],
  ])("%s rejects before fetching (%#)", async (_name, call) => {
    await expect(call()).rejects.toThrow(/slug/i);
    expect(fetchHtml).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

// Typed client errors reach the tool layer unchanged.
describe("error pass-through", () => {
  const calls = [
    ["search", () => search("x"), fetchJson],
    ["browseTag", () => browseTag("electronic", "top", "stale"), fetchJson],
    ["getAlbum", () => getAlbum("a/album/b"), fetchHtml],
    ["getArtist", () => getArtist("a"), fetchHtml],
    ["getTrack", () => getTrack("a/track/b"), fetchHtml],
  ] as const;

  it.each(calls)("%s rethrows the httpClient's error as is", async (_name, call, fetcher) => {
    for (const err of [
      new NotFoundError("gone"),
      new BandcampUnavailableError("down"),
      new BandcampChallengeError("challenge"),
    ]) {
      vi.mocked(fetcher).mockRejectedValueOnce(err);
      await expect(call()).rejects.toBe(err);
    }
  });
});
