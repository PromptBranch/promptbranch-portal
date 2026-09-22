import { z } from "zod";

/**
 * Domain IDs and command IDs are UUID strings (C2). Comparison is the
 * server's job; the schema only enforces the wire format.
 */
export const idSchema = z.uuid();
export type Id = z.infer<typeof idSchema>;

/** Change-feed sequences are decimal strings, never JavaScript numbers (C2). */
export const seqSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export type Seq = z.infer<typeof seqSchema>;

/** UTC RFC3339 timestamps; numeric offsets are rejected (C2). */
export const timestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof timestampSchema>;

/** `lowercase SHA-256(UTF8(content))` (C3). */
export const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type ContentHash = z.infer<typeof contentHashSchema>;

export const emailSchema = z.email();
