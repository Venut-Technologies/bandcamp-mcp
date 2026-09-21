export interface SanitizedText {
  text: string;
  truncated: boolean;
}

const DEFAULT_MAX_LENGTH = 2000;

// Only real markup shapes: an HTML comment, or '<' immediately followed by a
// letter or '/'+letter. A bare '<' in user text ("<3", "a < b", "->") is not a
// tag and must survive — a generic `<[^>]*>` would pair "<3" with a later ">"
// and delete everything between them.
const MARKUP_PATTERN = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;

// C0 controls except \t \n \r, DEL, and the C1 controls U+0080-U+009F (e.g.
// CSI U+009B, NEL U+0085).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Every character that renders as nothing but can carry or reorder hidden
// text, by Unicode property rather than a hand-kept list:
// - Default_Ignorable_Code_Point: zero-width space/joiners, LRM/RLM and the
//   Arabic letter mark U+061C, bidi embeddings/overrides/isolates, word joiner
//   and invisible operators (U+2060-U+206F), soft hyphen, U+180E and the
//   Mongolian variation selectors, variation selectors (U+FE00-U+FE0F,
//   U+E0100-U+E01EF), BOM, Hangul fillers, and the Tag characters
//   (U+E0000-U+E007F) used to smuggle invisible instructions;
// - Cf (format): the remaining format controls, e.g. U+FFF9-U+FFFB.
// The u flag makes astral code points (Tags, U+E0100...) match whole.
const INVISIBLE_CHARS = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const ENTITY_PATTERN = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos|nbsp));/g;

function codePointToString(codePoint: number, original: string): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : original;
}

// One regex pass: the replacer's output is never scanned again, so "&amp;lt;"
// becomes the literal text "&lt;" (what the user typed), not "<".
export function decodeEntities(input: string): string {
  return input.replace(ENTITY_PATTERN, (entity: string, dec?: string, hex?: string, named?: string) => {
    if (dec !== undefined) return codePointToString(Number(dec), entity);
    if (hex !== undefined) return codePointToString(parseInt(hex, 16), entity);
    return NAMED_ENTITIES[named as string] ?? entity;
  });
}

function stripMarkup(input: string): string {
  return input.replace(MARKUP_PATTERN, "");
}

function stripInvisible(input: string): string {
  return input.replace(CONTROL_CHARS, "").replace(INVISIBLE_CHARS, "");
}

// Order matters:
// 1. strip real markup from the raw input, while every raw '<' that starts a
//    tag is still recognisable (an encoded '&lt;' can't pair with it);
// 2. decode entities once;
// 3. drop control/zero-width characters (including decoded ones) — before the
//    final markup strip, so "<\u200Bscript>" can't hide a tag from it;
// 4. strip markup again, so no tag decoded from "&lt;b&gt;" leaves the client;
// 5. trim, then cap with a truncated flag.
export function sanitizeText(
  input: string | null | undefined,
  maxLength: number = DEFAULT_MAX_LENGTH
): SanitizedText {
  if (!input) {
    return { text: "", truncated: false };
  }
  const cleaned = stripMarkup(stripInvisible(decodeEntities(stripMarkup(input)))).trim();
  if (cleaned.length <= maxLength) {
    return { text: cleaned, truncated: false };
  }
  return { text: cleaned.slice(0, maxLength), truncated: true };
}
