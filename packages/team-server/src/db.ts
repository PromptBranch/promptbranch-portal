import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

export interface TeamPoolOptions {
  max?: number;
  applicationName?: string;
}

/**
 * Pool for the team PostgreSQL database. Parameterized SQL only; all
 * workspace-scoped access goes through domain services that pass an explicit
 * transaction — never through unauthenticated `getById` helpers.
 */
export function createTeamPool(connectionString: string, options: TeamPoolOptions = {}): Pool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Safety net: no single query or idle transaction may park forever; the
    // transaction runner keeps workloads well under these bounds.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: options.applicationName ?? "promptbranch-team-server",
  });
}

/**
 * Runs `fn` inside one transaction. Rolls back on any throw (validation,
 * authorization, SQL errors) so partial mutations never survive.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  // A connection whose rollback itself failed is unusable; releasing it with
  // an error destroys it instead of returning it to the pool.
  let poisoned = false;
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        poisoned = true;
      }
      throw error;
    }
  } finally {
    client.release(poisoned ? new Error("team transaction rollback failed") : undefined);
  }
}
