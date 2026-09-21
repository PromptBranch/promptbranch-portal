import { listAgentTokens } from "@promptbranch/team-server";
import { MintTokenForm, RevokeTokenButton } from "@/components/team/settings-actions";
import { requireWorkspacePage } from "@/lib/team/ssr";

// Agent capabilities: metadata only (secrets never leave creation), mint
// with an explicit one-time-copy warning, revoke anywhere.

export default async function AgentTokensSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { service, workspace, auth } = await requireWorkspacePage(workspaceId);
  const tokens = await listAgentTokens(service.pool, auth, workspaceId).catch(() => []);
  const canWriteScopes = ["owner", "maintainer", "contributor"].includes(workspace.role);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Agent tokens</h1>
        <p className="mt-1 max-w-xl text-xs text-ink-dim">
          Scoped workspace capabilities for CLI/MCP agents. Effective access is always the token scopes ∩ your current role;
          role changes and removals revoke them immediately.
        </p>
        <div className="mt-4 max-w-xl rounded-xl border border-line bg-panel p-4">
          <MintTokenForm workspaceId={workspaceId} canWriteScopes={canWriteScopes} />
        </div>
      </section>

      <section aria-label="Existing tokens">
        <h2 className="text-sm font-semibold">Existing tokens</h2>
        {tokens.length === 0 ? (
          <p className="mt-2 text-xs text-ink-faint">No tokens yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {tokens.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-xs">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{token.name}</span>
                  <span className="block text-ink-faint">
                    {token.scopes.join(", ")} · expires {new Date(token.expiresAt).toLocaleDateString()}
                    {token.revokedAt ? " · revoked" : ""}
                  </span>
                </span>
                {token.revokedAt ? null : <RevokeTokenButton epoch={workspace.serverEpoch} workspaceId={workspaceId} tokenId={token.id} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
