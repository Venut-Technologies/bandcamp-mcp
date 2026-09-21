import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import {
  BandcampChallengeError,
  BandcampShapeChangedError,
  BandcampUnavailableError,
  NotFoundError,
} from "../../src/client/errors.js";
import { mapClientError, notFoundAsDrift } from "../../src/tools/errorMapping.js";

const SHAPE_CHANGED_TEXT =
  "Bandcamp's response format looks like it changed, so this tool can't parse it right now. " +
  "This is likely a known, tracked issue — check https://github.com/Venut-Technologies/bandcamp-mcp/issues.";
const CHALLENGE_TEXT =
  "Bandcamp served a bot-check or interstitial page instead of data (possibly rate limiting). " +
  "Try again in a few minutes; if it persists, see https://github.com/Venut-Technologies/bandcamp-mcp/issues.";

const text = (value: string) => [{ type: "text", text: value }];

// Follow-up C: drift, challenge and unavailable leave a line on stderr for
// the user to paste into an issue; the spy keeps it out of the test output.
let stderr: MockInstance<typeof console.error>;
beforeEach(() => {
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => stderr.mockRestore());

describe("mapClientError", () => {
  it("turns NotFoundError into non-error text that keeps the client's reason", () => {
    const err = new NotFoundError("x.bandcamp.com redirects outside bandcamp.com (e.g. to an artist's custom domain)");
    expect(mapClientError(err, 'No artist found for "x".')).toEqual({
      content: text(
        `No artist found for "x". (x.bandcamp.com redirects outside bandcamp.com (e.g. to an artist's custom domain))`
      ),
    });
  });

  it("reports shape drift as an error that links the issue tracker", () => {
    expect(mapClientError(new BandcampShapeChangedError("auto.results missing"), "unused")).toEqual({
      content: text(SHAPE_CHANGED_TEXT),
      isError: true,
    });
    expect(stderr).toHaveBeenCalledExactlyOnceWith("[bandcamp-mcp] BandcampShapeChangedError: auto.results missing");
  });

  it("reports a bot-check/interstitial page with its own text, distinct from shape drift", () => {
    expect(mapClientError(new BandcampChallengeError("HTML where JSON was expected"), "unused")).toEqual({
      content: text(CHALLENGE_TEXT),
      isError: true,
    });
    expect(stderr).toHaveBeenCalledExactlyOnceWith("[bandcamp-mcp] BandcampChallengeError: HTML where JSON was expected");
  });

  it("reports Bandcamp being unavailable as an error with the client's reason", () => {
    expect(mapClientError(new BandcampUnavailableError("Bandcamp returned 503"), "unused")).toEqual({
      content: text("Bandcamp is temporarily unavailable: Bandcamp returned 503"),
      isError: true,
    });
    expect(stderr).toHaveBeenCalledExactlyOnceWith("[bandcamp-mcp] BandcampUnavailableError: Bandcamp returned 503");
  });

  it("logs nothing for not-found, an invalid slug or a non-Error value: those are not Bandcamp-side faults", () => {
    mapClientError(new NotFoundError("none"), "unused");
    mapClientError(new Error("Invalid artist slug \"x y\""), "unused");
    mapClientError("boom", "unused");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("reports any other Error (e.g. an invalid slug) as an error carrying its message instead of throwing", () => {
    const err = new Error('Invalid Bandcamp slug "Nightglass" — expected "artist/album/item-slug"');
    expect(mapClientError(err, "unused")).toEqual({ content: text(err.message), isError: true });
  });

  it("reports a thrown non-Error value as a generic error", () => {
    expect(mapClientError("boom", "unused")).toEqual({
      content: text("Unexpected error while talking to Bandcamp."),
      isError: true,
    });
  });
});

describe("notFoundAsDrift", () => {
  it("reports NotFoundError from a fixed JSON endpoint as shape drift", () => {
    expect(notFoundAsDrift(new NotFoundError("Not found: https://bandcamp.com/api/x"))).toEqual({
      content: text(SHAPE_CHANGED_TEXT),
      isError: true,
    });
    expect(stderr).toHaveBeenCalledExactlyOnceWith("[bandcamp-mcp] NotFoundError: Not found: https://bandcamp.com/api/x");
  });

  it("maps every other error exactly like mapClientError", () => {
    for (const err of [
      new BandcampChallengeError("c"),
      new BandcampShapeChangedError("s"),
      new BandcampUnavailableError("u"),
      new Error("e"),
      42,
    ]) {
      expect(notFoundAsDrift(err)).toEqual(mapClientError(err, "unused"));
    }
  });
});
