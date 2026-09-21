import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../../src/client/bandcampClient.js", () => ({ getAlbum: vi.fn() }));

import { getAlbum } from "../../src/client/bandcampClient.js";
import { BandcampUnavailableError, NotFoundError } from "../../src/client/errors.js";
import { AlbumSchema } from "../../src/client/types.js";
import { parseDetailSlug } from "../../src/client/urlSafety.js";
import { getAlbumToolConfig, getAlbumToolHandler } from "../../src/tools/getAlbum.js";
import { UNTRUSTED_TEXT_NOTE } from "../../src/tools/shared.js";
import { connectTool, type ConnectedTool } from "./harness.js";

// A compilation, so the per-track artist differs from the album artist.
const album = AlbumSchema.parse({
  title: "Paper Kite 10th Anniversary",
  artist: "Various Artists",
  releaseDate: "15 Nov 2017 00:00:00 GMT",
  tracks: [
    {
      title: "Night",
      artist: "Marlow Vesper",
      position: 1,
      durationSeconds: 313,
      slug: "paperkiterecords/track/night",
    },
    { title: "Ruins", artist: "Zola Jesus", position: 2, durationSeconds: null, slug: null },
  ],
  tags: ["electronic", "compilation"],
  description: { text: "Ten years of the label.", truncated: false },
  priceText: "7",
  priceCurrency: "USD",
  isNameYourPrice: false,
  label: "Paper Kite Records",
});

describe("bandcamp_get_album tool", () => {
  let tool: ConnectedTool;

  beforeAll(async () => {
    tool = await connectTool("bandcamp_get_album", getAlbumToolConfig, getAlbumToolHandler);
  });
  afterAll(() => tool.close());
  beforeEach(() => {
    vi.clearAllMocks();
    // mapClientError logs Bandcamp-side faults to stderr (covered in
    // errorMapping.test.ts); silenced here to keep the output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("is listed with a slug-only schema whose wording the description repeats", async () => {
    const { tools } = await tool.client.listTools();
    expect(tools).toHaveLength(1);
    const [listed] = tools;
    expect(listed.name).toBe("bandcamp_get_album");
    expect(listed.inputSchema.required).toEqual(["slug"]);
    const slugProperty = listed.inputSchema.properties?.slug as { description?: string; maxLength?: number };
    expect(slugProperty.maxLength).toBe(200);
    const slugHelp = slugProperty.description;
    expect(slugHelp).toContain('"<subdomain>/album/<item>"');
    expect(slugHelp).toContain('"johncarpentermusic/album/cathedral"');
    expect(slugHelp).toContain("never a display name");
    expect(slugHelp).toContain('https://<subdomain>.bandcamp.com/album/<item>, pass "<subdomain>/album/<item>"');
    expect(listed.description).toContain(slugHelp);
  });

  it("describes the price fields, the per-track artist and slug, and ends with the untrusted-text note", async () => {
    const { tools } = await tool.client.listTools();
    const description = tools[0].description ?? "";
    for (const field of ["priceText", "priceCurrency", "isNameYourPrice", "tracks[].artist", "tracks[].slug"]) {
      expect(description).toContain(field);
    }
    expect(description).toContain("bandcamp_get_track");
    expect(description.endsWith(UNTRUSTED_TEXT_NOTE)).toBe(true);
  });

  it("passes the slug through to getAlbum", async () => {
    vi.mocked(getAlbum).mockResolvedValueOnce(album);
    await tool.call({ slug: "paperkiterecords/album/paper-kite-10th-anniversary" });
    expect(getAlbum).toHaveBeenCalledExactlyOnceWith("paperkiterecords/album/paper-kite-10th-anniversary");
  });

  it("returns the album as compact JSON that parses back to what the client returned", async () => {
    vi.mocked(getAlbum).mockResolvedValueOnce(album);
    const { text, isError } = await tool.call({ slug: "paperkiterecords/album/paper-kite-10th-anniversary" });
    expect(isError).toBe(false);
    expect(text).toBe(JSON.stringify(album));
    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toEqual(album);
  });

  it.each([
    ["a missing slug", {}],
    ["an empty slug", { slug: "" }],
    ["a 201-character slug", { slug: "a".repeat(201) }],
  ])("rejects %s as an input validation error without calling Bandcamp", async (_label, args) => {
    const { text, isError } = await tool.call(args);
    expect(isError).toBe(true);
    expect(text).toContain("Input validation error");
    expect(getAlbum).not.toHaveBeenCalled();
  });

  it("answers a missing album with friendly non-error text naming the slug and the client's reason", async () => {
    vi.mocked(getAlbum).mockRejectedValueOnce(
      new NotFoundError("Not found: https://marlowvesper.bandcamp.com/album/nope")
    );
    expect(await tool.call({ slug: "marlowvesper/album/nope" })).toEqual({
      text: 'No album found for "marlowvesper/album/nope". (Not found: https://marlowvesper.bandcamp.com/album/nope)',
      isError: false,
    });
  });

  it("reports a display name passed as the slug with the client's slug-validation message", async () => {
    vi.mocked(getAlbum).mockImplementationOnce(async (slug) => {
      parseDetailSlug(slug, "album");
      throw new Error("unreachable: parseDetailSlug accepted a display name");
    });
    expect(await tool.call({ slug: "Nightglass" })).toEqual({
      text: 'Invalid Bandcamp slug "Nightglass" — expected "artist/album/item-slug"',
      isError: true,
    });
  });

  it("reports Bandcamp being unavailable as an error", async () => {
    vi.mocked(getAlbum).mockRejectedValueOnce(
      new BandcampUnavailableError("Bandcamp returned 503 for https://marlowvesper.bandcamp.com/album/nightglass")
    );
    expect(await tool.call({ slug: "marlowvesper/album/nightglass" })).toEqual({
      text: "Bandcamp is temporarily unavailable: Bandcamp returned 503 for https://marlowvesper.bandcamp.com/album/nightglass",
      isError: true,
    });
  });

  // The SDK would turn a thrown handler error into this same isError result
  // (see harness.ts), so only a direct call proves the handler mapped it.
  it("resolves to the mapped result, never rejects, when the client throws a plain Error", async () => {
    vi.mocked(getAlbum).mockRejectedValueOnce(new Error('Invalid item slug segment "x_y"'));
    await expect(getAlbumToolHandler({ slug: "a/album/x_y" })).resolves.toEqual({
      content: [{ type: "text", text: 'Invalid item slug segment "x_y"' }],
      isError: true,
    });
  });
});
