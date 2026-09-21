// Translates client errors into tool results the model can act on: each kind
// of failure gets its own wording, so "Bandcamp changed its format" is never
// confused with "nothing matched". A tool never throws: every failure becomes
// a text result.
import {
  BandcampChallengeError,
  BandcampShapeChangedError,
  BandcampUnavailableError,
  NotFoundError,
} from "../client/errors.js";
import { errorResult, textResult, type ToolTextResult } from "./shared.js";

export const ISSUES_URL = "https://github.com/Venut-Technologies/bandcamp-mcp/issues";

const SHAPE_CHANGED_TEXT = `Bandcamp's response format looks like it changed, so this tool can't parse it right now. This is likely a known, tracked issue — check ${ISSUES_URL}.`;
const CHALLENGE_TEXT = `Bandcamp served a bot-check or interstitial page instead of data (possibly rate limiting). Try again in a few minutes; if it persists, see ${ISSUES_URL}.`;

// Bandcamp-side faults (drift, bot-check, outage) also go to stderr, which a
// stdio MCP server may use freely: the model sees only the friendly text, the
// user gets the client's reason to paste into an issue.
export function logDiagnostic(err: Error): void {
  console.error(`[bandcamp-mcp] ${err.name}: ${err.message}`);
}

// `notFoundMessage` is the tool's own "nothing here" sentence; the client's
// reason is appended because not every NotFoundError means "doesn't exist"
// (a custom-domain redirect, for one). Any other Error (e.g. an invalid slug)
// is reported with its message. There is no ZodError branch: the client
// routes every schema validation through parseOrShapeChanged.
export function mapClientError(err: unknown, notFoundMessage: string): ToolTextResult {
  if (err instanceof NotFoundError) return textResult(`${notFoundMessage} (${err.message})`);
  if (err instanceof BandcampShapeChangedError) {
    logDiagnostic(err);
    return errorResult(SHAPE_CHANGED_TEXT);
  }
  if (err instanceof BandcampChallengeError) {
    logDiagnostic(err);
    return errorResult(CHALLENGE_TEXT);
  }
  if (err instanceof BandcampUnavailableError) {
    logDiagnostic(err);
    return errorResult(`Bandcamp is temporarily unavailable: ${err.message}`);
  }
  if (err instanceof Error) return errorResult(err.message);
  return errorResult("Unexpected error while talking to Bandcamp.");
}

// For the fixed JSON endpoints (search, browse): "no matches" arrives as an
// empty list, so a NotFoundError means the endpoint itself moved — drift, not
// "nothing found".
export function notFoundAsDrift(err: unknown): ToolTextResult {
  if (err instanceof NotFoundError) {
    logDiagnostic(err);
    return errorResult(SHAPE_CHANGED_TEXT);
  }
  return mapClientError(err, "");
}
