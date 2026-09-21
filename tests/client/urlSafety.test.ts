import { describe, it, expect } from "vitest";
import {
  parseArtistSlug,
  parseDetailSlug,
  detailSlugToUrl,
  artistSlugToUrl,
  detailSlugToString,
  assertSafeBandcampUrl,
  urlToDetailSlug,
  urlToArtistSlug,
} from "../../src/client/urlSafety.js";

describe("parseDetailSlug", () => {
  it("parses a valid album slug", () => {
    expect(parseDetailSlug("marlowvesper/album/nightglass", "album")).toEqual({
      artist: "marlowvesper",
      itemType: "album",
      item: "nightglass",
    });
  });

  it("rejects a slug whose type doesn't match what was expected", () => {
    expect(() => parseDetailSlug("someartist/track/song", "album")).toThrow();
  });

  it("rejects malformed slugs", () => {
    expect(() => parseDetailSlug("not-a-valid-slug", "album")).toThrow();
    expect(() => parseDetailSlug("artist/album/", "album")).toThrow();
    expect(() => parseDetailSlug("../../etc/passwd", "album")).toThrow();
  });

  // Bandcamp slugifies a non-Latin title by collapsing it to dashes, so real
  // item slugs look like "-", "--4", "--6" (live: kryrartambient/album/--6 is
  // "Остановиться" by Velho). The item pattern is ^[a-z0-9-]+$; a
  // stricter one makes most of the non-Latin catalog unaddressable.
  it("accepts a dash-only item slug", () => {
    expect(parseDetailSlug("kryrartambient/album/--6", "album")).toEqual({
      artist: "kryrartambient",
      itemType: "album",
      item: "--6",
    });
    expect(parseDetailSlug("kryrartambient/album/-", "album").item).toBe("-");
    expect(detailSlugToUrl(parseDetailSlug("kryrartambient/album/-", "album")).toString()).toBe(
      "https://kryrartambient.bandcamp.com/album/-"
    );
    expect(parseDetailSlug("kryrartambient/track/--19", "track").item).toBe("--19");
  });

  it("keeps the artist segment strict — it becomes a DNS label", () => {
    expect(() => parseDetailSlug("-evil/album/x", "album")).toThrow();
    expect(() => parseDetailSlug("evil-/album/x", "album")).toThrow();
  });

  it("still rejects traversal and encoding probes in the item segment", () => {
    expect(() => parseDetailSlug("artist/album/..", "album")).toThrow();
    expect(() => parseDetailSlug("artist/album/a.b", "album")).toThrow();
    expect(() => parseDetailSlug("artist/album/%2e%2e", "album")).toThrow();
    expect(() => parseDetailSlug("artist/album/a_b", "album")).toThrow();
  });
});

describe("parseArtistSlug", () => {
  it("parses a valid artist slug", () => {
    expect(parseArtistSlug("paperkiterecords")).toBe("paperkiterecords");
  });

  it("rejects slugs with unsafe characters", () => {
    expect(() => parseArtistSlug("evil.com/../x")).toThrow();
    expect(() => parseArtistSlug("")).toThrow();
  });
});

describe("URL building", () => {
  it("builds the expected album/track URL", () => {
    const url = detailSlugToUrl({ artist: "marlowvesper", itemType: "album", item: "nightglass" });
    expect(url.toString()).toBe("https://marlowvesper.bandcamp.com/album/nightglass");
  });

  it("builds the expected artist URL", () => {
    expect(artistSlugToUrl("paperkiterecords").toString()).toBe("https://paperkiterecords.bandcamp.com/");
  });

  it("round-trips a detail slug to its string form", () => {
    expect(detailSlugToString({ artist: "a", itemType: "track", item: "b" })).toBe("a/track/b");
  });
});

describe("assertSafeBandcampUrl (SSRF prevention)", () => {
  it("accepts real bandcamp.com and *.bandcamp.com URLs", () => {
    expect(() => assertSafeBandcampUrl("https://bandcamp.com/discover")).not.toThrow();
    expect(() => assertSafeBandcampUrl("https://paperkiterecords.bandcamp.com/album/x")).not.toThrow();
  });

  it("rejects a lookalike host", () => {
    expect(() => assertSafeBandcampUrl("https://bandcamp.com.evil.example/")).toThrow();
    expect(() => assertSafeBandcampUrl("https://notbandcamp.com/")).toThrow();
  });

  it("rejects IP-literal hosts", () => {
    expect(() => assertSafeBandcampUrl("http://169.254.169.254/latest/meta-data/")).toThrow();
    expect(() => assertSafeBandcampUrl("http://[::1]/")).toThrow();
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertSafeBandcampUrl("file:///etc/passwd")).toThrow();
  });

  it("rejects malformed URLs", () => {
    expect(() => assertSafeBandcampUrl("not a url")).toThrow();
  });
});

describe("urlToDetailSlug / urlToArtistSlug", () => {
  it("extracts a detail slug from a real album URL", () => {
    expect(urlToDetailSlug("https://marlowvesper.bandcamp.com/album/nightglass")).toEqual({
      artist: "marlowvesper",
      itemType: "album",
      item: "nightglass",
    });
  });

  it("returns null for a bare artist homepage (no item path)", () => {
    expect(urlToDetailSlug("https://paperkiterecords.bandcamp.com/")).toBeNull();
  });

  it("keeps a dash-only item slug instead of dropping it", () => {
    expect(urlToDetailSlug("https://kryrartambient.bandcamp.com/album/--6")).toEqual({
      artist: "kryrartambient",
      itemType: "album",
      item: "--6",
    });
  });

  it("still drops an item segment with unsafe characters", () => {
    expect(urlToDetailSlug("https://kryrartambient.bandcamp.com/album/a.b")).toBeNull();
  });

  it("extracts an artist slug from a bandcamp subdomain URL", () => {
    expect(urlToArtistSlug("https://paperkiterecords.bandcamp.com/")).toBe("paperkiterecords");
  });

  it("throws rather than silently accepting an unsafe host", () => {
    expect(() => urlToDetailSlug("https://evil.example/album/x")).toThrow();
  });
});
