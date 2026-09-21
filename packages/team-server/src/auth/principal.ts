/**
 * Server-authored principal identity (contract C4 `/principal`).
 *
 * `principalId` is authoritative cache/ownership identity — `human:<userId>`
 * or `agent:<tokenId>` — and is always derived server-side; client-supplied
 * user/principal IDs never choose ownership or cache namespaces.
 */

export type Scope = "catalog:read" | "proposal:write" | "note:write" | "run:write";

export type Principal =
  | { kind: "human"; userId: string; sessionId: string; authenticatedAt: string }
  | { kind: "agent"; userId: string; tokenId: string; scopes: Scope[] };

export function principalId(principal: Principal): string {
  return principal.kind === "human" ? `human:${principal.userId}` : `agent:${principal.tokenId}`;
}
