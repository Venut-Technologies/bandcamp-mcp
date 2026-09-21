import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../../src/client/bandcampClient.js", () => ({ getTrack: vi.fn() }));

import { getTrack } from "../../src/client/bandcampClient.js";
import { BandcampUnavailableError, NotFoundError } from "../../src/client/errors.js";
import { TrackDetailSchema } from "../../src/client/types.js";
import { parseDetailSlug } from "../../src/client/urlSafety.js";
import { getTrackToolConfig, getTrackToolHandler } from "../../src/tools/getTrack.js";
import { UNTRUSTED_TEXT_NOTE } from "../../src/tools/shared.js";
import { connectTool, type ConnectedTool } from "./harness.js";

// A track on an album, as getTrack returns it for track-glass-meridian.html.
const albumTrack = TrackDetailSchema.parse({
  title: "Glass Meridian",
  artist: "Marlow Vesper",
  durationSeconds: 264,
  slug: "marlowvesper/track/glass-meridian",
  album: { title: "Nightglass", slug: "marlowvesper/album/nightglass" },
  tags: ["electronic", "soundtrack"],
  description: { text: "", truncated: false },
});

// A standalone single: its inAlbum repeats the track title and has no @id.
const single = TrackDetailSchema.parse({
  title: "Slow Lantern",
  artist: "Cobalt Heron",
  durationSeconds: 594,
  slug: "cobaltheron/track/slow-lantern",
  album: { title: "Slow Lantern", slug: null },
  tags: [],
  description: { text: "12-inch single.", truncated: false },
});

describe("bandcamp_get_track tool", () => {
  let tool: ConnectedTool;

  beforeAll(async () => {
    tool = await connectTool("bandcamp_get_track", getTrackToolConfig, getTrackToolHandler);
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
    expect(listed.name).toBe("bandcamp_get_track");
    expect(listed.inputSchema.required).toEqual(["slug"]);
    const slugProperty = listed.inputSchema.properties?.slug as { description?: string; maxLength?: number };
    expect(slugProperty.maxLength).toBe(200);
    const slugHelp = slugProperty.description;
    expect(slugHelp).toContain('"<subdomain>/track/<item>"');
    expect(slugHelp).toContain("never a display name");
    expect(slugHelp).toContain('https://<subdomain>.bandcamp.com/track/<item>, pass "<subdomain>/track/<item>"');
    expect(listed.description).toContain(slugHelp);
  });

  it("describes the any-track-page contract and ends with the untrusted-text note", async () => {
    const { tools } = await tool.client.listTools();
    const description = tools[0].description ?? "";
    expect(description).toContain(
      "Get detail for one Bandcamp track page, either a standalone single or a track on an album. " +
        "Pass tracks[].slug from bandcamp_get_album or a track slug from bandcamp_search. " +
        "The result's album tells you which album it belongs to. For a whole tracklist use bandcamp_get_album."
    );
    expect(description).not.toContain("does NOT work");
    expect(description.endsWith(UNTRUSTED_TEXT_NOTE)).toBe(true);
  });

  it("passes the slug through to getTrack", async () => {
    vi.mocked(getTrack).mockResolvedValueOnce(albumTrack);
    await tool.call({ slug: "marlowvesper/track/glass-meridian" });
    expect(getTrack).toHaveBeenCalledExactlyOnceWith("marlowvesper/track/glass-meridian");
  });

  it.each([
    ["a track on an album", albumTrack],
    ["a standalone single", single],
  ])("returns %s as compact JSON that parses back to what the client returned", async (_label, track) => {
    vi.mocked(getTrack).mockResolvedValueOnce(track);
    const { text, isError } = await tool.call({ slug: track.slug });
    expect(isError).toBe(false);
    expect(text).toBe(JSON.stringify(track));
    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toEqual(track);
  });

  it.each([
    ["a missing slug", {}],
    ["an empty slug", { slug: "" }],
    ["a 201-character slug", { slug: "a".repeat(201) }],
  ])("rejects %s as an input validation error without calling Bandcamp", async (_label, args) => {
    const { text, isError } = await tool.call(args);
    expect(isError).toBe(true);
    expect(text).toContain("Input validation error");
    expect(getTrack).not.toHaveBeenCalled();
  });

  it("answers a missing track with friendly non-error text naming the slug and the client's reason", async () => {
    vi.mocked(getTrack).mockRejectedValueOnce(
      new NotFoundError("Not found: https://marlowvesper.bandcamp.com/track/nope")
    );
    expect(await tool.call({ slug: "marlowvesper/track/nope" })).toEqual({
      text: 'No track found for "marlowvesper/track/nope". (Not found: https://marlowvesper.bandcamp.com/track/nope)',
      isError: false,
    });
  });

  it("reports an album slug with the client's slug-validation message", async () => {
    vi.mocked(getTrack).mockImplementationOnce(async (slug) => {
      parseDetailSlug(slug, "track");
      throw new Error("unreachable: parseDetailSlug accepted an album slug");
    });
    expect(await tool.call({ slug: "marlowvesper/album/nightglass" })).toEqual({
      text: 'Expected a "track" slug but got type "album"',
      isError: true,
    });
  });

  it("reports Bandcamp being unavailable as an error", async () => {
    vi.mocked(getTrack).mockRejectedValueOnce(
      new BandcampUnavailableError("Bandcamp returned 503 for https://marlowvesper.bandcamp.com/track/glass-meridian")
    );
    expect(await tool.call({ slug: "marlowvesper/track/glass-meridian" })).toEqual({
      text: "Bandcamp is temporarily unavailable: Bandcamp returned 503 for https://marlowvesper.bandcamp.com/track/glass-meridian",
      isError: true,
    });
  });

  // The SDK would turn a thrown handler error into this same isError result
  // (see harness.ts), so only a direct call proves the handler mapped it.
  it("resolves to the mapped result, never rejects, when the client throws a plain Error", async () => {
    vi.mocked(getTrack).mockRejectedValueOnce(new Error('Expected a "track" slug but got type "album"'));
    await expect(getTrackToolHandler({ slug: "a/album/b" })).resolves.toEqual({
      content: [{ type: "text", text: 'Expected a "track" slug but got type "album"' }],
      isError: true,
    });
  });
});
