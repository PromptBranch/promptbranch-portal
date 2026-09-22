import { z } from "zod";

/**
 * Protocol-wide bounds from C2. `TEAM_LIMITS` is the exact `TeamInfo.limits`
 * vocabulary; effective operator quotas may be lower, never higher.
 */
export const TEAM_LIMITS = {
  maxRequestBytes: 262144,
  maxResponsePageBytes: 524288,
  maxContentBytes: 65536,
  maxPageSize: 100,
  maxMembers: 50,
  maxPrompts: 5000,
  maxPublishedContentBytes: 209715200,
  maxProposals: 50000,
  maxActiveTokensPerMember: 20,
} as const;

export const teamLimitsSchema = z.object({
  maxRequestBytes: z.number().int().positive(),
  maxResponsePageBytes: z.number().int().positive(),
  maxContentBytes: z.number().int().positive(),
  maxPageSize: z.number().int().positive(),
  maxMembers: z.number().int().positive(),
  maxPrompts: z.number().int().positive(),
  maxPublishedContentBytes: z.number().int().positive(),
  maxProposals: z.number().int().positive(),
  maxActiveTokensPerMember: z.number().int().positive(),
});
export type TeamLimits = z.infer<typeof teamLimitsSchema>;

/**
 * UTF-8 byte length without Node's Buffer so the runtime root stays usable
 * outside Node (C9: no Node-only dependencies in the root export).
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: a well-formed pair encodes one 4-byte character. A
      // lone surrogate is not valid UTF-8; count 3 so bounds stay conservative.
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Revision content: ≤64 KiB of UTF-8, measured in bytes (C2). */
export const contentSchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= TEAM_LIMITS.maxContentBytes);

export const titleSchema = z.string().min(1).max(200);
export const descriptionSchema = z.string().max(2000);
export const tagNameSchema = z.string().min(1).max(50);
export const collectionNameSchema = z.string().min(1).max(100);
export const workspaceNameSchema = z.string().min(1).max(100);
export const searchQuerySchema = z.string().max(200);

/** C2: rationale/comment/note ≤8,000 characters; reason/rationale nonblank. */
export const rationaleSchema = z
  .string()
  .max(8000)
  .refine((value) => value.trim().length > 0);
export const reasonSchema = rationaleSchema;
export const commentBodySchema = z.string().max(8000);

export const MAX_TAGS_PER_PROMPT = 20;
export const MAX_COLLECTIONS_PER_PROMPT = 20;

export const pageLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(TEAM_LIMITS.maxPageSize);
export const DEFAULT_PAGE_LIMIT = 50;

/** Entity versions and metrics must stay exactly representable (C2 tests). */
export const entityVersionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
export const nonNegativeIntSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const nonNegativeNumberSchema = z.number().min(0);
