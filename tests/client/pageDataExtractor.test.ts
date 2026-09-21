import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  extractJsonLd,
  extractTags,
  extractAbout,
  extractCredits,
  extractDiscography,
  extractLandingRelease,
  extractArtistName,
  extractArtistLocation,
  extractArtistBio,
  assertArtistPage,
} from "../../src/client/pageDataExtractor.js";
import { sanitizeText } from "../../src/client/sanitize.js";
import { BandcampChallengeError, BandcampShapeChangedError, NotFoundError } from "../../src/client/errors.js";

const albumHtml = readFileSync(new URL("../fixtures/album-nightglass.html", import.meta.url), "utf-8");
const artistHtml = readFileSync(new URL("../fixtures/artist-paperkite.html", import.meta.url), "utf-8");
const vesperMusicHtml = readFileSync(new URL("../fixtures/artist-marlowvesper-music.html", import.meta.url), "utf-8");
const landingAlbumHtml = readFileSync(new URL("../fixtures/artist-landing-album.html", import.meta.url), "utf-8");
const fanStubHtml = readFileSync(new URL("../fixtures/artist-fan-stub.html", import.meta.url), "utf-8");

describe("extractJsonLd", () => {
  it("extracts and parses the JSON-LD block from a real album page", () => {
    const data = extractJsonLd(albumHtml);
    expect(typeof data.name).toBe("string");
  });

  it("throws BandcampShapeChangedError when no JSON-LD block is present", () => {
    expect(() => extractJsonLd("<html><body>no ld+json here</body></html>")).toThrow(BandcampShapeChangedError);
  });

  it("throws BandcampChallengeError when the page looks like a bot challenge", () => {
    expect(() => extractJsonLd("<html><body>Just a moment...</body></html>")).toThrow(BandcampChallengeError);
  });

  it.each(["null", '"Nightglass"', "42", "true", "[]", '[{"name":"Nightglass"}]'])(
    "throws BandcampShapeChangedError when the JSON-LD root is %s, not an object",
    (json) => {
      const html = `<script type="application/ld+json">${json}</script>`;
      expect(() => extractJsonLd(html)).toThrow(BandcampShapeChangedError);
      expect(() => extractJsonLd(html)).toThrow(/not a JSON object/);
    }
  );
});

describe("extractTags / extractAbout / extractCredits", () => {
  it("returns an array (possibly empty) of tags without throwing", () => {
    expect(Array.isArray(extractTags(albumHtml))).toBe(true);
  });

  it("returns a string or null for about/credits without throwing", () => {
    expect(["string", "object"]).toContain(typeof extractAbout(albumHtml));
    expect(["string", "object"]).toContain(typeof extractCredits(albumHtml));
  });
});

// A #music-grid renders only its first 16 releases as <li> entries; the rest
// of the catalog sits in the grid's data-client-items JSON attribute.
describe("extractDiscography", () => {
  it("reads a real label page's <li> entries, then its data-client-items, in grid order", () => {
    const grid = extractDiscography(artistHtml);
    // 16 <li> entries + 384 client items (no overlap on this page)
    expect(grid).toMatchObject({ found: true, itemCount: 400 });
    const discography = grid.entries;
    expect(discography).toHaveLength(400);
    expect(discography[0]).toEqual({
      title: "Neon Tape",
      url: "https://kiro-vane.bandcamp.com/album/night-tape",
      artist: "Selah Ferrer",
    });
    expect(discography[2]).toEqual({
      title: "Nightglass",
      url: "https://marlowvesper.bandcamp.com/album/nightglass",
      artist: "Marlow Vesper",
    });
    // <li> markup is left raw (entities intact) for sanitizeText
    expect(discography[8].artist).toBe("Noor Ferrer &amp; Kiro Vane");
    // the first client item comes right after the last <li>
    expect(discography[16]).toEqual({
      title: "Winter Mirror",
      url: "https://odile-ferrer.bandcamp.com/album/cedar-tape",
      artist: "Bram Ferrer",
    });
  });

  it("keeps a single-artist page's relative hrefs and has no per-entry artist unless one is credited", () => {
    const grid = extractDiscography(vesperMusicHtml);
    // 16 <li> entries + 10 client items
    expect(grid).toMatchObject({ found: true, itemCount: 26 });
    const discography = grid.entries;
    expect(discography).toHaveLength(26);
    expect(discography[1]).toEqual({ title: "Nightglass", url: "/album/nightglass", artist: null });
    expect(discography[2]).toEqual({
      title: "Static Harbour",
      url: "/album/cedar-circuit",
      artist: "Ilya Vane",
    });
    expect(discography[16]).toEqual({
      title: "Quiet Signal",
      url: "/album/copper-signal",
      artist: null,
    });
    expect(discography.find((entry) => entry.title === "Static Signal")?.artist).toBe("Ilya Vane");
  });

  it("pairs each title with its own <li>'s link", () => {
    const html =
      `<ol id="music-grid"><li><a href="/album/a"><p class="title">A</p></a></li>` +
      `<li><a href="/album/b"><div class="art"></div></a></li>` +
      `<li><a href="/track/c"><p class="title">C<br><span class="artist-override">Guest</span></p></a></li></ol>`;
    expect(extractDiscography(html)).toEqual({
      found: true,
      // the <li> without a title is still counted as a listed release
      itemCount: 3,
      entries: [
        { title: "A", url: "/album/a", artist: null },
        { title: "C", url: "/track/c", artist: "Guest" },
      ],
    });
  });

  it("ignores malformed data-client-items and keeps the <li> entries", () => {
    const grid = (items: string) =>
      `<ol id="music-grid" data-client-items="${items}"><li><a href="/album/a"><p class="title">A</p></a></li></ol>`;
    const li = [{ title: "A", url: "/album/a", artist: null }];
    expect(extractDiscography(grid("[{&quot;title&quot;:"))).toEqual({ found: true, itemCount: 1, entries: li });
    expect(extractDiscography(grid("{&quot;title&quot;:&quot;B&quot;}"))).toEqual({ found: true, itemCount: 1, entries: li });
    expect(
      extractDiscography(grid("[null,{&quot;title&quot;:7},{&quot;title&quot;:&quot;B&quot;,&quot;page_url&quot;:&quot;/album/b&quot;}]"))
    ).toEqual({ found: true, itemCount: 4, entries: [...li, { title: "B", url: "/album/b", artist: null }] });
  });

  it("returns nothing for a page without #music-grid instead of scanning the whole page", () => {
    // a real /music request that 303-redirected to an album page
    expect(landingAlbumHtml).not.toMatch(/id="music-grid"/);
    expect(extractDiscography(landingAlbumHtml)).toEqual({ found: false, itemCount: 0, entries: [] });
    expect(extractDiscography(albumHtml)).toEqual({ found: false, itemCount: 0, entries: [] });
  });

  it("tells a genuinely empty grid from one whose entries no longer parse", () => {
    expect(extractDiscography(`<ol id="music-grid"></ol>`)).toEqual({ found: true, itemCount: 0, entries: [] });
    expect(extractDiscography(`<ol id="music-grid" data-client-items="[]"></ol>`)).toEqual({
      found: true,
      itemCount: 0,
      entries: [],
    });
    const drifted = vesperMusicHtml
      .replace(/<p class="title">/g, '<p class="release-name">')
      .replace(/\sdata-client-items="[^"]*"/, "");
    expect(extractDiscography(drifted)).toEqual({ found: true, itemCount: 16, entries: [] });
  });
});

describe("extractLandingRelease", () => {
  it("describes the release a redirected artist page landed on", () => {
    expect(extractLandingRelease(landingAlbumHtml)).toEqual({
      title: "SONGS FOR THE NIGHT SHIFT",
      url: "https://paleledger.bandcamp.com/album/songs-for-the-night-shift",
      artist: "Adaeze Hart, Juno Ferrer, kalaya",
    });
  });

  it("returns null for an artist page (no JSON-LD) and for unusable JSON-LD", () => {
    expect(extractLandingRelease(artistHtml)).toBeNull();
    const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;
    expect(extractLandingRelease(ld("{not json"))).toBeNull();
    expect(extractLandingRelease(ld("null"))).toBeNull();
    expect(extractLandingRelease(ld('{"@type":"MusicGroup","@id":"https://x.bandcamp.com","name":"X"}'))).toBeNull();
    expect(extractLandingRelease(ld('{"@type":"MusicAlbum","name":"X"}'))).toBeNull();
  });
});

// Artist pages carry no application/ld+json block at all (verified against
// this real fixture — extractJsonLd would throw on it). Name/location/bio
// have to come from plain markup instead.
describe("extractArtistName / extractArtistLocation / extractArtistBio", () => {
  it("has no application/ld+json block on a real artist page", () => {
    expect(() => extractJsonLd(artistHtml)).toThrow(BandcampShapeChangedError);
  });

  it("extracts the artist name from #band-name-location on a real artist page", () => {
    expect(extractArtistName(artistHtml)).toBe("Paper Kite Records");
  });

  it("extracts the location from #band-name-location on a real artist page", () => {
    expect(extractArtistLocation(artistHtml)).toBe("Rotterdam");
  });

  it("extracts the bio text from the real, server-rendered #bio-text element", () => {
    expect(extractArtistBio(artistHtml)).toBe("Records for restless listeners");
  });

  // Verbatim markup from the live sunn.bandcamp.com page (fetched 2026-09-19):
  // a long bio is split into a visible part, a nested peekaboo-text overflow
  // span and a "... more" toggle, with <br> line breaks. The extractor leaves
  // entities for sanitizeText, so assert on what the consumer sees.
  it("extracts a long, nested-markup bio without the '... more' toggle", () => {
    const html = `<p id="bio-text">
                        Sunn O)))) formed 1996, Seattle WA <br>
 A synthesis of diverse: drone, ur, noise, metal, minimalism/maximalism;
                        <span class="peekaboo-text">supported by a cast of collaborators, O))) has two core members: Stephen O&#39;Malley and Greg Anderson.<br><span class="lightweightBreak"></span><br>All digital sales directly go to O))) funding future actions. Hail to our great fans! Thank you all very much for your support so far and in the future! WE RESPECT!</span>
                        <span class="peekaboo-link"><span class="peekaboo-ellipsis">...</span>&nbsp;<a>more</a></span>
                    </p>`;
    expect(sanitizeText(extractArtistBio(html)).text).toBe(
      "Sunn O)))) formed 1996, Seattle WA\n" +
        "A synthesis of diverse: drone, ur, noise, metal, minimalism/maximalism; supported by a cast of " +
        "collaborators, O))) has two core members: Stephen O'Malley and Greg Anderson.\n\n" +
        "All digital sales directly go to O))) funding future actions. Hail to our great fans! " +
        "Thank you all very much for your support so far and in the future! WE RESPECT!"
    );
  });

  // Regression: a user-typed '<' arrives as &lt;. The extractor strips real
  // tags while every raw '<' is still a tag, so the decoded '<' can never pair
  // with a real tag's '>' and delete the text between (sanitizeText also only
  // strips real tag shapes now — defence in depth).
  it("strips real tags itself so an encoded '<' in a long bio can't swallow text", () => {
    const html =
      `<p id="bio-text">We make noise &lt;3 since 2003 <br> Touring; ` +
      `<span class="peekaboo-text">new record.</span> <span class="peekaboo-link">...</span></p>`;
    expect(extractArtistBio(html)).toBe("We make noise &lt;3 since 2003\nTouring; new record.");
  });

  it("falls back to the bio part of <meta name=\"description\"> when #bio-text is absent", () => {
    const html = `<meta name="description" content="
Some Band.
Berlin.
Makes noise.
Loudly.
">
<p id="band-name-location">
    <span class="title">Some Band</span>
    <span class="location secondaryText">Berlin</span>
</p>`;
    expect(extractArtistBio(html)).toBe("Makes noise.\nLoudly.");
  });

  // Verbatim markup from the live warprecords.bandcamp.com page (fetched
  // 2026-09-19), a label with no bio: the meta description is only the
  // "{name}.\n{location}." preamble, which must not be passed off as a bio.
  it("returns null for an artist with no bio instead of the meta name/location preamble", () => {
    const html = `<meta name="description" content="
Warp Records.
Leeds, UK.
">
    <p id="band-name-location">
        <span class="title">Warp Records</span>
        <span class="location secondaryText">Leeds, UK</span>
    </p>
        <div class="signed-out-artists-bio-text">

        </div>`;
    expect(extractArtistBio(html)).toBeNull();
  });

  it("reads the bio from #bio-text itself, not from the meta fallback", () => {
    const withoutMeta = artistHtml.replace(/<meta[^>]*name="description"[^>]*>/, "");
    expect(withoutMeta).not.toMatch(/name="description"/);
    expect(extractArtistBio(withoutMeta)).toBe("Records for restless listeners");
  });

  it("falls back to the real page's meta description when #bio-text is removed", () => {
    const withoutBioText = artistHtml.replace('id="bio-text"', 'id="bio-text-renamed"');
    expect(withoutBioText).not.toMatch(/id="bio-text"/);
    expect(extractArtistBio(withoutBioText)).toBe("Records for restless listeners");
  });

  it("ends #bio-text at its own closing tag, not at the next </p>", () => {
    const html = `<span id="bio-text">Short bio</span><div><p>Unrelated paragraph</p></div>`;
    expect(extractArtistBio(html)).toBe("Short bio");
  });

  it("treats an unclosed #bio-text as absent", () => {
    expect(extractArtistBio(`<div id="bio-text">never closed <p>other</p>`)).toBeNull();
  });

  // Verbatim markup from the live realliferockandrollband.bandcamp.com page
  // (fetched 2026-09-19): the meta description double-encodes '&' while
  // #band-name-location encodes it once, so the preamble only matches once
  // both sides are fully decoded.
  it("drops the meta preamble when the name is encoded differently there", () => {
    const html = `<meta name="description" content="
Real Life Rock &amp;amp; Roll Band.
Oakland, California.
The Greatest Rock &amp;amp; Roll Band in the World
">
    <p id="band-name-location">
        <span class="title">Real Life Rock &amp; Roll Band</span>
        <span class="location secondaryText">Oakland, California</span>
    </p>`;
    expect(extractArtistBio(html)).toBe("The Greatest Rock &amp;amp; Roll Band in the World");
  });

  it("returns null for all three when the markup is absent", () => {
    expect(extractArtistName("<html><body></body></html>")).toBeNull();
    expect(extractArtistLocation("<html><body></body></html>")).toBeNull();
    expect(extractArtistBio("<html><body></body></html>")).toBeNull();
  });
});

describe("assertArtistPage", () => {
  it("accepts a real artist page", () => {
    expect(() => assertArtistPage(artistHtml)).not.toThrow();
  });

  // Album pages carry the same artist sidebar (#band-name-location, #bio-text)
  // — and an artist root whose landing page is a release 303-redirects to that
  // album page (seen live 2026-09-19: songs-of-arrakis, sargept, 1216), so it
  // has to be accepted.
  it("accepts a real album page, which carries the same artist sidebar", () => {
    expect(() => assertArtistPage(albumHtml)).not.toThrow();
  });

  it("throws BandcampChallengeError for a bot-challenge interstitial", () => {
    const challenge =
      `<!DOCTYPE html><html><head><title>Just a moment...</title></head>` +
      `<body><div id="challenge-running"></div></body></html>`;
    expect(() => assertArtistPage(challenge)).toThrow(BandcampChallengeError);
  });

  it("throws BandcampShapeChangedError for unrelated HTML", () => {
    expect(() => assertArtistPage("<html><body><h1>Hello</h1></body></html>")).toThrow(BandcampShapeChangedError);
  });

  it("throws BandcampShapeChangedError when the block has no .title element", () => {
    const drifted = artistHtml.replace('<span class="title">Paper Kite Records</span>', "<span>Paper Kite Records</span>");
    expect(drifted).not.toBe(artistHtml);
    expect(() => assertArtistPage(drifted)).toThrow(BandcampShapeChangedError);
    expect(() => assertArtistPage(drifted)).toThrow(/\.title/);
  });

  it("accepts a block whose .title is empty (that is a missing name, not drift)", () => {
    expect(() => assertArtistPage(`<p id="band-name-location"><span class="title"></span></p>`)).not.toThrow();
  });

  it("throws BandcampShapeChangedError when the real page's #band-name-location block is gone", () => {
    const drifted = artistHtml.replace('id="band-name-location"', 'id="band-name-and-location"');
    expect(() => assertArtistPage(drifted)).toThrow(BandcampShapeChangedError);
    expect(() => assertArtistPage(drifted)).toThrow(/band-name-location/);
  });

  // A subdomain held by a fan/listener account answers 200 with a stub
  // profile: no #band-name-location, no #music-grid, no JSON-LD. That is
  // semantically empty content, not shape drift.
  it("throws NotFoundError, not drift, for a real fan/stub profile page", () => {
    expect(() => assertArtistPage(fanStubHtml)).toThrow(NotFoundError);
    expect(() => assertArtistPage(fanStubHtml)).not.toThrow(BandcampShapeChangedError);
  });

  it("still prefers the challenge verdict over the stub verdict", () => {
    const challengeStub = `<html><body>Just a moment<div class="stub-page-content fan"></div></body></html>`;
    expect(() => assertArtistPage(challengeStub)).toThrow(BandcampChallengeError);
  });
});
