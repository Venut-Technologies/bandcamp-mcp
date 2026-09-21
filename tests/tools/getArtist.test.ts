import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../../src/client/bandcampClient.js", () => ({ getArtist: vi.fn() }));

import { getArtist } from "../../src/client/bandcampClient.js";
import { BandcampUnavailableError, NotFoundError } from "../../src/client/errors.js";
import { ArtistSchema } from "../../src/client/types.js";
import { parseArtistSlug } from "../../src/client/urlSafety.js";
import { getArtistToolConfig, getArtistToolHandler } from "../../src/tools/getArtist.js";
import { UNTRUSTED_TEXT_NOTE } from "../../src/tools/shared.js";
import { connectTool, type ConnectedTool } from "./harness.js";

// A label: its releases credit their own artists.
const artist = ArtistSchema.parse({
  name: "Paper Kite Records",
  location: "Brooklyn, Rotterdam",
  bio: { text: "Independent label founded in 2007.", truncated: false },
  discography: [
    { title: "Nightglass", slug: "marlowvesper/album/nightglass", type: "album", artist: "Marlow Vesper" },
    { title: "Label Sampler", slug: "paperkiterecords/track/label-sampler", type: "track", artist: null },
  ],
  discographyTotal: 2,
  discographyTruncated: false,
});

describe("bandcamp_get_artist tool", () => {
  let tool: ConnectedTool;

  beforeAll(async () => {
    tool = await connectTool("bandcamp_get_artist", getArtistToolConfig, getArtistToolHandler);
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
    expect(listed.name).toBe("bandcamp_get_artist");
    expect(listed.inputSchema.required).toEqual(["slug"]);
    const slugProperty = listed.inputSchema.properties?.slug as { description?: string; maxLength?: number };
    expect(slugProperty.maxLength).toBe(200);
    const slugHelp = slugProperty.description;
    expect(slugHelp).toContain('"sacredbonesrecords"');
    expect(slugHelp).toContain("first segment of any album or track slug");
    expect(slugHelp).toContain("https://<subdomain>.bandcamp.com/");
    expect(slugHelp).toContain("never a display name");
    expect(listed.description).toContain(slugHelp);
  });

  it("describes per-entry artists, the 100-release cap, the missing tags and custom domains, and ends with the untrusted-text note", async () => {
    const { tools } = await tool.client.listTools();
    const description = tools[0].description ?? "";
    expect(description).toContain("On a label, an entry's artist names the release's actual artist");
    expect(description).toContain("An entry with slug null (e.g. a release on a custom domain) cannot be looked up.");
    for (const text of ["first 100 releases", "discographyTruncated", "discographyTotal", "no tags", "custom domain"]) {
      expect(description).toContain(text);
    }
    expect(description).toContain("bandcamp_get_album");
    expect(description.endsWith(UNTRUSTED_TEXT_NOTE)).toBe(true);
  });

  it("passes the slug through to getArtist", async () => {
    vi.mocked(getArtist).mockResolvedValueOnce(artist);
    await tool.call({ slug: "paperkiterecords" });
    expect(getArtist).toHaveBeenCalledExactlyOnceWith("paperkiterecords");
  });

  it("returns the artist as compact JSON that parses back to what the client returned", async () => {
    vi.mocked(getArtist).mockResolvedValueOnce(artist);
    const { text, isError } = await tool.call({ slug: "paperkiterecords" });
    expect(isError).toBe(false);
    expect(text).toBe(JSON.stringify(artist));
    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toEqual(artist);
  });

  it.each([
    ["a missing slug", {}],
    ["an empty slug", { slug: "" }],
    ["a 201-character slug", { slug: "a".repeat(201) }],
  ])("rejects %s as an input validation error without calling Bandcamp", async (_label, args) => {
    const { text, isError } = await tool.call(args);
    expect(isError).toBe(true);
    expect(text).toContain("Input validation error");
    expect(getArtist).not.toHaveBeenCalled();
  });

  it("answers a missing artist with friendly non-error text naming the slug and the client's reason", async () => {
    vi.mocked(getArtist).mockRejectedValueOnce(
      new NotFoundError("No such Bandcamp artist: https://nope.bandcamp.com/music redirects to Bandcamp's signup page")
    );
    expect(await tool.call({ slug: "nope" })).toEqual({
      text: 'No artist found for "nope". (No such Bandcamp artist: https://nope.bandcamp.com/music redirects to Bandcamp\'s signup page)',
      isError: false,
    });
  });

  it("keeps the custom-domain reason, so the answer doesn't read as 'doesn't exist'", async () => {
    const reason =
      "https://cobaltheron.bandcamp.com/music redirects outside bandcamp.com (e.g. to an artist's custom domain), which this server does not follow";
    vi.mocked(getArtist).mockRejectedValueOnce(new NotFoundError(reason));
    expect(await tool.call({ slug: "cobaltheron" })).toEqual({
      text: `No artist found for "cobaltheron". (${reason})`,
      isError: false,
    });
  });

  it("reports a display name passed as the slug with the client's slug-validation message", async () => {
    vi.mocked(getArtist).mockImplementationOnce(async (slug) => {
      parseArtistSlug(slug);
      throw new Error("unreachable: parseArtistSlug accepted a display name");
    });
    expect(await tool.call({ slug: "Paper Kite" })).toEqual({
      text: 'Invalid artist slug "Paper Kite"',
      isError: true,
    });
  });

  it("reports Bandcamp being unavailable as an error", async () => {
    vi.mocked(getArtist).mockRejectedValueOnce(
      new BandcampUnavailableError("Bandcamp returned 503 for https://paperkiterecords.bandcamp.com/music")
    );
    expect(await tool.call({ slug: "paperkiterecords" })).toEqual({
      text: "Bandcamp is temporarily unavailable: Bandcamp returned 503 for https://paperkiterecords.bandcamp.com/music",
      isError: true,
    });
  });

  // The SDK would turn a thrown handler error into this same isError result
  // (see harness.ts), so only a direct call proves the handler mapped it.
  it("resolves to the mapped result, never rejects, when the client throws a plain Error", async () => {
    vi.mocked(getArtist).mockRejectedValueOnce(new Error('Invalid artist slug "a b"'));
    await expect(getArtistToolHandler({ slug: "a b" })).resolves.toEqual({
      content: [{ type: "text", text: 'Invalid artist slug "a b"' }],
      isError: true,
    });
  });
});
