import { z } from "zod";

const envSchema = z.object({
  // No domain is required yet: every absolute URL derives from this value
  // and http://<ip>:3000 is a valid configuration (spec: locked decisions).
  PUBLIC_BASE_URL: z.url().default("http://localhost:3000"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().min(1).default("./data"),
});

export type PortalEnv = z.infer<typeof envSchema>;

/**
 * Parsed on every call rather than cached: route tests point DATA_DIR at
 * per-test values by mutating process.env.
 */
export function getEnv(source: Record<string, string | undefined> = process.env): PortalEnv {
  return envSchema.parse({
    PUBLIC_BASE_URL: source.PUBLIC_BASE_URL,
    PORT: source.PORT,
    DATA_DIR: source.DATA_DIR,
  });
}
