import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

vi.mock("../../src/client/bandcampClient.js", () => ({ browseTag: vi.fn() }));

import { browseTag } from "../../src/client/bandcampClient.js";
import {
  BandcampShapeChangedError,
  BandcampUnavailableError,
  NotFoundError,
} from "../../src/client/errors.js";
import { normalizeDiscoverResults } from "../../src/client/normalize.js";
import { browseTagToolConfig, browseTagToolHandler } from "../../src/tools/browseTag.js";
import { UNTRUSTED_TEXT_NOTE } from "../../src/tools/shared.js";
import { connectTool, type ConnectedTool } from "./harness.js";

const ISSUES_URL = "https://github.com/Venut-Technologies/bandcamp-mcp/issues";

// The real captured discover_web response, through the real normalizer.
const page = normalizeDiscoverResults(
  JSON.parse(readFileSync(new URL("../fixtures/browse-electronic-top.json", import.meta.url), "utf-8"))
);
const emptyPage = { results: [], nextCursor: null };

describe("bandcamp_browse_tag tool", () => {
  let tool: ConnectedTool;

  beforeAll(async () => {
    tool = await connectTool("bandcamp_browse_tag", browseTagToolConfig, browseTagToolHandler);
  });
  afterAll(() => tool.close());
  beforeEach(() => {
    vi.clearAllMocks();
    // mapClientError logs Bandcamp-side faults to stderr (covered in
    // errorMapping.test.ts); silenced here to keep the output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("is listed with optional bounded tag/cursor, a top/new sort defaulting to top, and the ruled wording", async () => {
    const { tools } = await tool.client.listTools();
    expect(tools).toHaveLength(1);
    const [listed] = tools;
    expect(listed.name).toBe("bandcamp_browse_tag");
    expect(listed.inputSchema.required ?? []).toEqual([]);
    const properties = listed.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties.tag).toMatchObject({
      minLength: 1,
      maxLength: 100,
      description:
        'Bandcamp tag slug as in bandcamp.com/discover/<tag>, lowercase and hyphenated, e.g. "ambient", "hip-hop-rap", "drum-bass"; non-Latin scripts are allowed, e.g. "русский-рок". Omit for an unfiltered listing.',
    });
    expect(properties.cursor).toMatchObject({
      minLength: 1,
      maxLength: 1000,
      description:
        "nextCursor from a previous bandcamp_browse_tag call made with the SAME tag and sort; omit for the first page.",
    });
    expect(properties.sort).toMatchObject({ enum: ["top", "new"], default: "top" });
    expect(listed.description).toContain("credited album artist");
    expect(listed.description).toContain("bandcamp_get_album");
    expect(listed.description).toContain(
      "A result with slug null (e.g. a release on a custom domain) cannot be looked up."
    );
    expect(listed.description?.endsWith(UNTRUSTED_TEXT_NOTE)).toBe(true);
  });

  it("with no arguments asks for the unfiltered top listing", async () => {
    vi.mocked(browseTag).mockResolvedValueOnce(page);
    await tool.call({});
    expect(browseTag).toHaveBeenCalledExactlyOnceWith(null, "top", undefined);
  });

  it("passes tag and sort through", async () => {
    vi.mocked(browseTag).mockResolvedValueOnce(page);
    await tool.call({ tag: "electronic", sort: "new" });
    expect(browseTag).toHaveBeenCalledExactlyOnceWith("electronic", "new", undefined);
  });

  it("passes a cursor through for the unfiltered listing", async () => {
    vi.mocked(browseTag).mockResolvedValueOnce(page);
    await tool.call({ cursor: "abc" });
    expect(browseTag).toHaveBeenCalledExactlyOnceWith(null, "top", "abc");
  });

  it("passes a cursor through together with a tag", async () => {
    vi.mocked(browseTag).mockResolvedValueOnce(page);
    await tool.call({ tag: "ambient", sort: "new", cursor: "abc" });
    expect(browseTag).toHaveBeenCalledExactlyOnceWith("ambient", "new", "abc");
  });

  // Bandcamp's own slugs, checked live 2026-09-19: bandcamp.com/tag/r-b is
  // "R&b", /tag/drum-bass "Drum & bass", /tag/francais "français"; through
  // discover_web "русский-рок" has 1234 results ("русскии-рок" 0), "日本" 131,
  // "ボーカロイド" 57 ("ホーカロイト" 0), "ลูกทุ่ง" 2 ("ล-กท-ง" 0).
  it.each([
    ["Hip Hop", "hip-hop"],
    ["drum & bass", "drum-bass"],
    ["drum&bass", "drum-bass"],
    ["R&B", "r-b"],
    ["  Ambient \n", "ambient"],
    ["--Post--Rock!!", "post-rock"],
    ["Français", "francais"],
    ["música popular", "musica-popular"],
    ["hip-hop-rap", "hip-hop-rap"],
    ["русский рок", "русский-рок"],
    ["русский-рок", "русский-рок"],
    ["Русский-Рок", "русский-рок"],
    ["日本", "日本"],
    ["ボーカロイド", "ボーカロイド"],
    ["ลูกทุ่ง", "ลูกทุ่ง"],
    // Invisible characters are dropped, not kept and not made separators.
    ["ambi\u00ADent", "ambient"],
    ["日本\uFE0F", "日本"],
  ])("normalizes the tag %j to Bandcamp's slug %j", async (tag, slug) => {
    vi.mocked(browseTag).mockResolvedValueOnce(page);
    await tool.call({ tag });
    expect(browseTag).toHaveBeenCalledExactlyOnceWith(slug, "top", undefined);
  });

  // Omitting tag is the only way to get the unfiltered listing: a tag that
  // normalizes to nothing must not silently widen to all of Bandcamp.
  it.each([
    [" ", ""],
    ["&", "&"],
    ["!! --", "!! --"],
    // A Hangul filler (an invisible letter) and a combining mark on nothing.
    ["\u3164", ""],
    ["\u0301", "\u0301"],
  ])("rejects the tag %j, which has no letters or digits, without calling Bandcamp", async (tag, echoed) => {
    expect(await tool.call({ tag, sort: "new" })).toEqual({
      text:
        `Tag "${echoed}" has no letters or digits; ` +
        'pass a Bandcamp tag slug such as "ambient", or omit tag for an unfiltered listing.',
      isError: true,
    });
    expect(browseTag).not.toHaveBeenCalled();
  });

  it("returns the page as compact JSON that parses back to what the client returned", async () => {
    vi.mocked(browseTag).mockResolvedValueOnce(page);
    const { text, isError } = await tool.call({ tag: "electronic" });
    expect(isError).toBe(false);
    expect(page.results).toHaveLength(20);
    expect(page.nextCursor).not.toBeNull();
    expect(text).toBe(JSON.stringify(page));
    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toEqual(page);
  });

  it("answers an empty first page for a tag with non-error text naming the normalized tag", async () => {
    vi.mocked(browseTag).mockResolvedValueOnce(emptyPage);
    expect(await tool.call({ tag: "Zzqxv Tag" })).toEqual({
      text: 'No releases found for tag "zzqxv-tag". Check the tag slug (e.g. on bandcamp.com/discover).',
      isError: false,
    });
  });

  it.each([
    ["with a tag", { tag: "ambient", cursor: "abc" }],
    ["without a tag", { cursor: "abc" }],
  ])("answers an empty page after a cursor %s as the end of the list", async (_label, args) => {
    vi.mocked(browseTag).mockResolvedValueOnce(emptyPage);
    expect(await tool.call(args)).toEqual({ text: "No more results.", isError: false });
  });

  it("answers an empty unfiltered first page with non-error text", async () => {
    vi.mocked(browseTag).mockResolvedValueOnce(emptyPage);
    expect(await tool.call({})).toEqual({ text: "No releases found.", isError: false });
  });

  it.each([
    ["for a tag", { tag: "ambient" }],
    ["after a cursor", { tag: "ambient", cursor: "abc" }],
  ])("passes on an empty page %s that still has a nextCursor instead of ending the list", async (_label, args) => {
    const emptyButMore = { results: [], nextCursor: "next-page-token" };
    vi.mocked(browseTag).mockResolvedValueOnce(emptyButMore);
    expect(await tool.call(args)).toEqual({ text: JSON.stringify(emptyButMore), isError: false });
  });

  it.each([
    ["an unknown sort", { sort: "hot" }],
    ["an empty tag", { tag: "" }],
    ["a 101-character tag", { tag: "a".repeat(101) }],
    ["an empty cursor", { cursor: "" }],
    ["a 1001-character cursor", { cursor: "a".repeat(1001) }],
  ])("rejects %s as an input validation error without calling Bandcamp", async (_label, args) => {
    const { text, isError } = await tool.call(args);
    expect(isError).toBe(true);
    expect(text).toContain("Input validation error");
    expect(browseTag).not.toHaveBeenCalled();
  });

  // docs/bandcamp-endpoints.md: a bad cursor, or one from another tag or
  // sort, gets HTTP 500.
  it("blames the cursor when Bandcamp answers a request that carried one with a 500, and logs it", async () => {
    vi.mocked(browseTag).mockRejectedValueOnce(
      new BandcampUnavailableError("Bandcamp returned 500 for https://bandcamp.com/api/discover/1/discover_web", {
        status: 500,
      })
    );
    expect(await tool.call({ tag: "ambient", cursor: "garbage" })).toEqual({
      text:
        "Bandcamp could not serve this page (Bandcamp returned 500 for https://bandcamp.com/api/discover/1/discover_web). " +
        "The cursor is probably invalid or from a call with a different tag or sort: " +
        "call bandcamp_browse_tag again without cursor to start from the first page.",
      isError: true,
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "[bandcamp-mcp] BandcampUnavailableError: Bandcamp returned 500 for https://bandcamp.com/api/discover/1/discover_web"
    );
  });

  it.each([
    [
      "a rate limit (no status)",
      new BandcampUnavailableError(
        "Bandcamp is rate-limiting requests and asked to retry after 30 seconds (https://bandcamp.com/api/discover/1/discover_web)"
      ),
    ],
    [
      "a network error (no status)",
      new BandcampUnavailableError(
        "Network error reaching https://bandcamp.com/api/discover/1/discover_web: getaddrinfo ENOTFOUND bandcamp.com"
      ),
    ],
    [
      "a 503",
      new BandcampUnavailableError("Bandcamp returned 503 for https://bandcamp.com/api/discover/1/discover_web", {
        status: 503,
      }),
    ],
  ])("reports %s after a cursor with the generic text, not as a bad cursor", async (_label, err) => {
    vi.mocked(browseTag).mockRejectedValueOnce(err);
    const result = await tool.call({ tag: "ambient", cursor: "abc" });
    expect(result).toEqual({ text: `Bandcamp is temporarily unavailable: ${err.message}`, isError: true });
    expect(result.text).not.toContain("cursor");
    expect(console.error).toHaveBeenCalledExactlyOnceWith(`[bandcamp-mcp] BandcampUnavailableError: ${err.message}`);
  });

  it.each([500, 503])(
    "reports a %i with the generic text when no cursor was given",
    async (status) => {
      const message = `Bandcamp returned ${status} for https://bandcamp.com/api/discover/1/discover_web`;
      vi.mocked(browseTag).mockRejectedValueOnce(new BandcampUnavailableError(message, { status }));
      expect(await tool.call({ tag: "ambient" })).toEqual({
        text: `Bandcamp is temporarily unavailable: ${message}`,
        isError: true,
      });
    }
  );

  it("reports other errors after a cursor as themselves, not as a bad cursor", async () => {
    vi.mocked(browseTag).mockRejectedValueOnce(new BandcampShapeChangedError("results missing"));
    const { text, isError } = await tool.call({ cursor: "abc" });
    expect(isError).toBe(true);
    expect(text).toContain("format looks like it changed");
    expect(text).not.toContain("cursor");
  });

  it("treats NotFoundError from the discover endpoint as drift, not as no releases", async () => {
    vi.mocked(browseTag).mockRejectedValueOnce(
      new NotFoundError("Not found: https://bandcamp.com/api/discover/1/discover_web")
    );
    const { text, isError } = await tool.call({ tag: "ambient" });
    expect(isError).toBe(true);
    expect(text).toContain("format looks like it changed");
    expect(text).toContain(ISSUES_URL);
    expect(text).not.toContain("No releases");
  });

  // The SDK would turn a thrown handler error into this same isError result
  // (see harness.ts), so only a direct call proves the handler mapped it.
  it("resolves to the mapped result, never rejects, when the client throws a plain Error", async () => {
    vi.mocked(browseTag).mockRejectedValueOnce(new Error("boom"));
    await expect(browseTagToolHandler({ sort: "top" })).resolves.toEqual({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
  });
});
