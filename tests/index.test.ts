// End to end through the real createServer(): the SDK's own Client
// over an in-memory transport, with only the Bandcamp client mocked. The
// per-tool behavior is covered in tests/tools/; this checks the wiring — which
// tools the server lists, and that each name reaches its own handler and
// client function.
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../src/client/bandcampClient.js", () => ({
  search: vi.fn(),
  getAlbum: vi.fn(),
  getArtist: vi.fn(),
  getTrack: vi.fn(),
  browseTag: vi.fn(),
}));

import { browseTag, getAlbum, getArtist, getTrack, search } from "../src/client/bandcampClient.js";
import { BandcampShapeChangedError, NotFoundError } from "../src/client/errors.js";
import { SearchResultSchema } from "../src/client/types.js";
import { createServer } from "../src/server.js";
import { UNTRUSTED_TEXT_NOTE } from "../src/tools/shared.js";
import { connectServer, type ConnectedServer } from "./tools/harness.js";

const ISSUES_URL = "https://github.com/Venut-Technologies/bandcamp-mcp/issues";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  version: string;
};

const results = SearchResultSchema.array().parse([
  { type: "album", name: "Quiet Circuit", artist: "Marlow Vesper", slug: "marlowvesper/album/quiet-circuit" },
]);

// The client functions' signatures differ; a table row mocks any of them
// through this common type.
type ClientFunction = (...args: never[]) => Promise<unknown>;

describe("bandcamp-mcp server", () => {
  let server: ConnectedServer;

  beforeAll(async () => {
    server = await connectServer(createServer());
  });
  afterAll(() => server.close());
  beforeEach(() => {
    vi.clearAllMocks();
    // Drift is also logged to stderr (covered in errorMapping.test.ts);
    // silenced here to keep the output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("reports serverInfo bandcamp-mcp at the package.json version", () => {
    expect(server.client.getServerVersion()).toEqual({ name: "bandcamp-mcp", version });
  });

  it("registers exactly the 5 expected tools", async () => {
    const { tools } = await server.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bandcamp_browse_tag",
      "bandcamp_get_album",
      "bandcamp_get_artist",
      "bandcamp_get_track",
      "bandcamp_search",
    ]);
  });

  it("gives every tool a description of its own plus the untrusted-text note", async () => {
    const { tools } = await server.client.listTools();
    for (const tool of tools) {
      expect(tool.description, tool.name).toContain(UNTRUSTED_TEXT_NOTE);
      expect(tool.description?.replace(UNTRUSTED_TEXT_NOTE, "").trim(), tool.name).not.toBe("");
    }
  });

  it('routes bandcamp_search {query: "x"} to search("x", "all") and returns the results as JSON text', async () => {
    vi.mocked(search).mockResolvedValueOnce(results);
    const result = await server.call("bandcamp_search", { query: "x" });
    expect(search).toHaveBeenCalledExactlyOnceWith("x", "all");
    expect(result).toEqual({ text: JSON.stringify(results), isError: false });
  });

  it('routes bandcamp_browse_tag {} to browseTag(null, "top", undefined) and returns the page as JSON text', async () => {
    const page = { results, nextCursor: null };
    vi.mocked(browseTag).mockResolvedValueOnce(page);
    const result = await server.call("bandcamp_browse_tag", {});
    expect(browseTag).toHaveBeenCalledExactlyOnceWith(null, "top", undefined);
    expect(result).toEqual({ text: JSON.stringify(page), isError: false });
  });

  it.each([
    { tool: "bandcamp_get_album", fn: getAlbum, slug: "marlowvesper/album/nightglass", kind: "album" },
    { tool: "bandcamp_get_artist", fn: getArtist, slug: "marlowvesper", kind: "artist" },
    { tool: "bandcamp_get_track", fn: getTrack, slug: "marlowvesper/track/glass-meridian", kind: "track" },
  ])("routes $tool to its own client function and reports a NotFoundError as plain text", async ({ tool, fn, slug, kind }) => {
    vi.mocked(fn as ClientFunction).mockRejectedValueOnce(new NotFoundError("Not found: https://example.bandcamp.com/"));
    const result = await server.call(tool, { slug });
    expect(fn).toHaveBeenCalledExactlyOnceWith(slug);
    expect(result).toEqual({
      text: `No ${kind} found for "${slug}". (Not found: https://example.bandcamp.com/)`,
      isError: false,
    });
  });

  it.each([
    { tool: "bandcamp_search", fn: search, args: { query: "x" } },
    { tool: "bandcamp_browse_tag", fn: browseTag, args: {} },
    { tool: "bandcamp_get_album", fn: getAlbum, args: { slug: "marlowvesper/album/nightglass" } },
    { tool: "bandcamp_get_artist", fn: getArtist, args: { slug: "marlowvesper" } },
    { tool: "bandcamp_get_track", fn: getTrack, args: { slug: "marlowvesper/track/glass-meridian" } },
  ])("reports a BandcampShapeChangedError from $tool as an error pointing at the issue tracker", async ({ tool, fn, args }) => {
    vi.mocked(fn as ClientFunction).mockRejectedValueOnce(new BandcampShapeChangedError("page structure changed"));
    const result = await server.call(tool, args);
    expect(fn).toHaveBeenCalledOnce();
    expect(result.isError).toBe(true);
    expect(result.text).toContain(ISSUES_URL);
  });
});
