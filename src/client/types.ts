import { z } from "zod";

// No stream/file/download field exists anywhere below — this is deliberate
// (see Global Constraints): this server never surfaces a URL that would let a
// client bypass Bandcamp's purchase flow.

export const TrackSchema = z.object({
  title: z.string().min(1),
  artist: z.string().min(1),
  position: z.number().int().positive(),
  durationSeconds: z.number().nonnegative().nullable(),
  slug: z.string().nullable(),
});
export type Track = z.infer<typeof TrackSchema>;

// get_track: any /track/ page, on an album or a standalone single. No
// position (a standalone single has none). `album` comes from JSON-LD inAlbum:
// null when inAlbum is absent; its slug is null when inAlbum has no @id (a
// real standalone single's inAlbum repeats the track's own title, no @id).
export const TrackDetailSchema = z.object({
  title: z.string().min(1),
  artist: z.string().min(1),
  durationSeconds: z.number().nonnegative().nullable(),
  slug: z.string().nullable(),
  album: z.object({ title: z.string().min(1), slug: z.string().nullable() }).nullable(),
  tags: z.array(z.string()),
  description: z.object({ text: z.string(), truncated: z.boolean() }),
});
export type TrackDetail = z.infer<typeof TrackDetailSchema>;

export const AlbumSchema = z.object({
  title: z.string().min(1),
  artist: z.string().min(1),
  releaseDate: z.string().nullable(),
  tracks: z.array(TrackSchema).min(1),
  tags: z.array(z.string()),
  description: z.object({ text: z.string(), truncated: z.boolean() }),
  priceText: z.string().nullable(),
  // ISO 4217 code from the same offer as priceText ("9" alone is ambiguous).
  priceCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  isNameYourPrice: z.boolean(),
  label: z.string().nullable(),
});
export type Album = z.infer<typeof AlbumSchema>;

export const DiscographyItemSchema = z.object({
  title: z.string().min(1),
  slug: z.string().nullable(),
  type: z.enum(["album", "track"]),
  // The release's own artist when the page credits one (a label's roster, a
  // collaboration); null means the page's own artist.
  artist: z.string().nullable(),
});
export type DiscographyItem = z.infer<typeof DiscographyItemSchema>;

// A label's catalog runs to hundreds of releases (Warp: 834), far past what a
// tool result should carry; the first entries in grid order are kept.
export const MAX_DISCOGRAPHY_ENTRIES = 100;

// Artist/label pages expose no tags (verified on the fixture and live roots),
// so there is no tags field.
export const ArtistSchema = z.object({
  name: z.string().min(1),
  location: z.string().nullable(),
  bio: z.object({ text: z.string(), truncated: z.boolean() }),
  discography: z.array(DiscographyItemSchema).max(MAX_DISCOGRAPHY_ENTRIES),
  // Entries before the cap.
  discographyTotal: z.number().int().nonnegative(),
  discographyTruncated: z.boolean(),
});
export type Artist = z.infer<typeof ArtistSchema>;

export const SearchResultSchema = z.object({
  type: z.enum(["album", "artist", "track", "label"]),
  name: z.string().min(1),
  artist: z.string().nullable(),
  slug: z.string().nullable(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
