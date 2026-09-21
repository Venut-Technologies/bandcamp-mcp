import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../../src/client/bandcampClient.js", () => ({ search: vi.fn() }));

import { search } from "../../src/client/bandcampClient.js";
import {
  BandcampChallengeError,
  BandcampShapeChangedError,
  BandcampUnavailableError,
  NotFoundError,
} from "../../src/client/errors.js";
import { SearchResultSchema } from "../../src/client/types.js";
import { searchToolConfig, searchToolHandler } from "../../src/tools/search.js";
import { UNTRUSTED_TEXT_NOTE } from "../../src/tools/shared.js";
import { connectTool, type ConnectedTool } from "./harness.js";

const ISSUES_URL = "https://github.com/Venut-Technologies/bandcamp-mcp/issues";

const results = SearchResultSchema.array().parse([
  { type: "album", name: "Quiet Circuit", artist: "Marlow Vesper", slug: "marlowvesper/album/quiet-circuit" },
  { type: "artist", name: "Marlow Vesper", artist: null, slug: "marlowvesper" },
  { type: "label", name: "Paper Kite Records", artist: null, slug: null },
]);

describe("bandcamp_search tool", () => {
  let tool: ConnectedTool;

  beforeAll(async () => {
    tool = await connectTool("bandcamp_search", searchToolConfig, searchToolHandler);
  });
  afterAll(() => tool.close());
  beforeEach(() => {
    vi.clearAllMocks();
    // mapClientError logs drift/challenge/unavailable to stderr (covered in
    // errorMapping.test.ts); silenced here to keep the output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("is listed with a description carrying the untrusted-text note and a query-required schema", async () => {
    const { tools } = await tool.client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("bandcamp_search");
    expect(tools[0].description).toContain(UNTRUSTED_TEXT_NOTE);
    expect(tools[0].inputSchema.required).toEqual(["query"]);
    expect(tools[0].inputSchema.properties?.query).toMatchObject({ minLength: 1, maxLength: 200 });
  });

  it("applies the default type: {query} calls search(query, \"all\")", async () => {
    vi.mocked(search).mockResolvedValueOnce(results);
    await tool.call({ query: "vesper" });
    expect(search).toHaveBeenCalledExactlyOnceWith("vesper", "all");
  });

  it("trims the query before calling search", async () => {
    vi.mocked(search).mockResolvedValueOnce(results);
    await tool.call({ query: "  vesper \n" });
    expect(search).toHaveBeenCalledExactlyOnceWith("vesper", "all");
  });

  it("accepts a 200-character query", async () => {
    vi.mocked(search).mockResolvedValueOnce(results);
    const { isError } = await tool.call({ query: "a".repeat(200) });
    expect(isError).toBe(false);
    expect(search).toHaveBeenCalledExactlyOnceWith("a".repeat(200), "all");
  });

  it("passes an explicit type through", async () => {
    vi.mocked(search).mockResolvedValueOnce([]);
    await tool.call({ query: "paper kite", type: "label" });
    expect(search).toHaveBeenCalledExactlyOnceWith("paper kite", "label");
  });

  it("returns the results as compact JSON that parses back to what the client returned", async () => {
    vi.mocked(search).mockResolvedValueOnce(results);
    const { text, isError } = await tool.call({ query: "vesper" });
    expect(isError).toBe(false);
    expect(text).toBe(JSON.stringify(results));
    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toEqual(results);
  });

  it("answers an empty result list with friendly non-error text", async () => {
    vi.mocked(search).mockResolvedValueOnce([]);
    expect(await tool.call({ query: "zzqxv" })).toEqual({ text: 'No results found for "zzqxv".', isError: false });
  });

  it("names the type in the empty-result text for a typed search and suggests type all", async () => {
    vi.mocked(search).mockResolvedValueOnce([]);
    expect(await tool.call({ query: "zzqxv", type: "label" })).toEqual({
      text: 'No label results found for "zzqxv" (try type "all").',
      isError: false,
    });
  });

  it("echoes the query sanitized: markup and invisible characters are stripped", async () => {
    vi.mocked(search).mockResolvedValueOnce([]);
    expect(await tool.call({ query: "<b>pa\u200Bper</b> \u202Ekite" })).toEqual({
      text: 'No results found for "paper kite".',
      isError: false,
    });
  });

  it.each([
    ["an empty query", { query: "" }],
    ["a whitespace-only query", { query: " \t\n " }],
    ["a 201-character query", { query: "a".repeat(201) }],
    ["a missing query", {}],
    ["an unknown type", { query: "x", type: "playlist" }],
  ])("rejects %s as an input validation error without calling Bandcamp", async (_label, args) => {
    const { text, isError } = await tool.call(args);
    expect(isError).toBe(true);
    expect(text).toContain("Input validation error");
    expect(search).not.toHaveBeenCalled();
  });

  it("treats NotFoundError from the search endpoint as drift, not as no results", async () => {
    vi.mocked(search).mockRejectedValueOnce(new NotFoundError("Not found: https://bandcamp.com/api/bcsearch_public_api"));
    const { text, isError } = await tool.call({ query: "x" });
    expect(isError).toBe(true);
    expect(text).toContain("format looks like it changed");
    expect(text).toContain(ISSUES_URL);
    expect(text).not.toContain("No results");
  });

  it("reports shape drift with the issues link", async () => {
    vi.mocked(search).mockRejectedValueOnce(new BandcampShapeChangedError("auto.results missing"));
    const { text, isError } = await tool.call({ query: "x" });
    expect(isError).toBe(true);
    expect(text).toContain("format looks like it changed");
    expect(text).toContain(ISSUES_URL);
  });

  it("reports a bot-check page with its own text", async () => {
    vi.mocked(search).mockRejectedValueOnce(new BandcampChallengeError("HTML where JSON was expected"));
    const { text, isError } = await tool.call({ query: "x" });
    expect(isError).toBe(true);
    expect(text).toContain("bot-check");
    expect(text).not.toContain("format looks like it changed");
    expect(text).toContain(ISSUES_URL);
  });

  it("reports Bandcamp being unavailable", async () => {
    vi.mocked(search).mockRejectedValueOnce(new BandcampUnavailableError("Bandcamp returned 503"));
    expect(await tool.call({ query: "x" })).toEqual({
      text: "Bandcamp is temporarily unavailable: Bandcamp returned 503",
      isError: true,
    });
  });

  it("reports any other Error as an error carrying its message", async () => {
    vi.mocked(search).mockRejectedValueOnce(new Error("Invalid something"));
    expect(await tool.call({ query: "x" })).toEqual({ text: "Invalid something", isError: true });
  });

  // The SDK would turn a thrown handler error into this same isError result
  // (see harness.ts), so only a direct call proves the handler mapped it.
  it("resolves to the mapped result, never rejects, when the client throws a plain Error", async () => {
    vi.mocked(search).mockRejectedValueOnce(new Error("Invalid something"));
    await expect(searchToolHandler({ query: "x", type: "all" })).resolves.toEqual({
      content: [{ type: "text", text: "Invalid something" }],
      isError: true,
    });
  });
});
