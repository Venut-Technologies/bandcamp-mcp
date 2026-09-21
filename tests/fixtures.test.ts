import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  redactStreamUrls,
  STREAM_URL_MARKER,
  STREAM_URL_REPLACEMENT,
} from "../scripts/redact-stream-urls.js";

const fixturesDir = new URL("./fixtures/", import.meta.url);

describe("redactStreamUrls", () => {
  it("redacts a stream URL inside an entity-encoded data-tralbum attribute and nothing else", () => {
    const attr =
      `data-tralbum="{&quot;url&quot;:&quot;https://x.bandcamp.com/album/y&quot;,&quot;file&quot;:` +
      `{&quot;mp3-128&quot;:&quot;https://t4.bcbits.com/stream/84db/mp3-128/389?p=0&amp;ts=1&amp;token=1_ab&quot;},` +
      `&quot;title&quot;:&quot;Glass Meridian&quot;}"`;
    expect(redactStreamUrls(attr)).toBe(
      `data-tralbum="{&quot;url&quot;:&quot;https://x.bandcamp.com/album/y&quot;,&quot;file&quot;:` +
        `{&quot;mp3-128&quot;:&quot;${STREAM_URL_REPLACEMENT}&quot;},` +
        `&quot;title&quot;:&quot;Glass Meridian&quot;}"`
    );
  });

  it("redacts raw, JSON-escaped and scheme-relative stream URLs", () => {
    expect(redactStreamUrls(`{"a":"https://t4.bcbits.com/stream/1/mp3-128/2?t=3","b":1}`)).toBe(
      `{"a":"${STREAM_URL_REPLACEMENT}","b":1}`
    );
    expect(redactStreamUrls(`{"a":"https:\\/\\/t4.bcbits.com\\/stream\\/1\\/mp3-128\\/2?t=3"}`)).toBe(
      `{"a":"${STREAM_URL_REPLACEMENT}"}`
    );
    expect(redactStreamUrls(`<audio src="//t4.bcbits.com/stream/1/mp3-128/2?t=3">`)).toBe(
      `<audio src="${STREAM_URL_REPLACEMENT}">`
    );
  });

  it("redacts a signed stream_redirect link in a recommendation tile's data-audiourl", () => {
    const attr =
      `data-audiourl="{&quot;mp3-128&quot;:&quot;https://bandcamp.com/stream_redirect?enc=mp3-128` +
      `&amp;track_id=2307468&amp;ts=1789&amp;t=b0c2&quot;}"`;
    expect(redactStreamUrls(attr)).toBe(`data-audiourl="{&quot;mp3-128&quot;:&quot;${STREAM_URL_REPLACEMENT}&quot;}"`);
  });

  it("redacts a signed freeDownloadPage grant inside data-tralbum", () => {
    const attr =
      `data-tralbum="{&quot;url&quot;:&quot;https://x.bandcamp.com/album/y&quot;,&quot;freeDownloadPage&quot;:` +
      `&quot;https://bandcamp.com/download?fsig=ce066f08bb5c8db820f53ffed0c3f271&amp;id=1761510550` +
      `&amp;ts=1789787855.3733594442&amp;type=album&quot;,&quot;title&quot;:&quot;Sodium Garden&quot;}"`;
    expect(redactStreamUrls(attr)).toBe(
      `data-tralbum="{&quot;url&quot;:&quot;https://x.bandcamp.com/album/y&quot;,&quot;freeDownloadPage&quot;:` +
        `&quot;${STREAM_URL_REPLACEMENT}&quot;,&quot;title&quot;:&quot;Sodium Garden&quot;}"`
    );
  });

  it("redacts a signed download URL on a bcbits-style download host", () => {
    expect(
      redactStreamUrls(`{"u":"https://popplers5.bandcamp.com/download/album?enc=mp3-v0&fsig=06a4&id=1&ts=2"}`)
    ).toBe(`{"u":"${STREAM_URL_REPLACEMENT}"}`);
  });

  it("leaves other bcbits.com URLs (cover art) alone", () => {
    const art = `<img src="https://f4.bcbits.com/img/a123_10.jpg">`;
    expect(redactStreamUrls(art)).toBe(art);
  });
});

// Fixtures are captured through scripts/capture-fixture.ts, which redacts
// signed stream and download URLs before writing.
describe("committed fixtures", () => {
  const files = readdirSync(fixturesDir);

  it("exist", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s contains no signed URL", (file) => {
    const text = readFileSync(new URL(file, fixturesDir), "utf-8");
    expect(text).not.toMatch(STREAM_URL_MARKER);
  });

  // Standalone, host- and path-agnostic guard: any future signed Bandcamp URL
  // shape carries an `fsig=` signature parameter, so this fails closed even on
  // a shape STREAM_URL_PATTERN cannot clean.
  it.each(files)("%s contains no signature parameter", (file) => {
    const text = readFileSync(new URL(file, fixturesDir), "utf-8");
    expect(text).not.toMatch(/fsig=/i);
  });

  // Fixtures are parser input, not republished release pages: the identities
  // and the prose in them are invented (see scripts/capture-fixture.ts). A
  // freshly captured page brings back an artist's own words, which are long;
  // the invented replacements are one short sentence. Length is the cheap,
  // mechanical signal that the rewriting step was skipped.
  const MAX_PROSE = 200;
  it.each(files)("%s carries no long free text", (file) => {
    const text = readFileSync(new URL(file, fixturesDir), "utf-8");
    const prose = [
      ...text.matchAll(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/g),
      ...text.matchAll(/name="description" content="([\s\S]*?)"/g),
      ...text.matchAll(/class="tralbum-(?:about|credits)"[^>]*>([\s\S]*?)<\/div>/g),
      ...text.matchAll(/id="bio-text"[^>]*>([\s\S]*?)</g),
    ].map((match) => match[1]);
    const tooLong = prose.filter((value) => value.length > MAX_PROSE);
    expect(tooLong).toEqual([]);
  });
});
