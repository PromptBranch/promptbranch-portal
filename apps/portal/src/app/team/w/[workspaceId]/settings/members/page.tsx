import { listInvitations, listMembers } from "@promptbranch/team-server";
import { InviteForm, RemoveMemberButton, RevokeInviteButton, RoleChangeForm } from "@/components/team/settings-actions";
import { requireWorkspacePage } from "@/lib/team/ssr";

// Owner-only member management. Last-owner removal is disabled client-side;
// the server refuses it regardless (contract-tested in team-server suites).

export default async function MembersSettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { service, workspace, auth } = await requireWorkspacePage(workspaceId);
  if (workspace.role !== "owner") {
    return <p className="rounded-xl border border-line bg-panel p-6 text-sm text-ink-dim">Only the workspace owner can manage members.</p>;
  }
  const [members, invitations] = await Promise.all([
    listMembers(service.pool, workspaceId),
    listInvitations(service.pool, workspaceId),
  ]);
  const ownerCount = members.filter((m) => m.role === "owner").length;

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Members</h1>
        <ul className="mt-4 space-y-2">
          {members.map((member) => {
            const isLastOwner = member.role === "owner" && ownerCount === 1;
            return (
              <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{member.displayName}</span>
                  <span className="block truncate text-xs text-ink-faint">{member.email}</span>
                </span>
                <span className="flex items-center gap-2">
                  <RoleChangeForm
                    epoch={workspace.serverEpoch} membershipGeneration={workspace.membershipGeneration}
                    workspaceId={workspaceId}
                    userId={member.userId}
                    currentRole={member.role}
                    expectedEntityVersion={member.entityVersion}
                    isLastOwner={isLastOwner}
                    isSelf={member.userId === auth.userId}
                  />
                  <RemoveMemberButton
                    epoch={workspace.serverEpoch} membershipGeneration={workspace.membershipGeneration}
                    workspaceId={workspaceId}
                    userId={member.userId}
                    expectedEntityVersion={member.entityVersion}
                    isLastOwner={isLastOwner}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold">Invite a teammate</h2>
        <p className="mt-1 text-xs text-ink-faint">Emails carry a single-use link that expires in 7 days and binds to the invited address.</p>
        <div className="mt-3 max-w-xl">
          <InviteForm epoch={workspace.serverEpoch} membershipGeneration={workspace.membershipGeneration} workspaceId={workspaceId} />
        </div>
        {invitations.length > 0 ? (
          <ul className="mt-4 space-y-1.5">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel px-3.5 py-2.5 text-xs">
                <span className="min-w-0 truncate text-ink-dim">
                  {invitation.email} · {invitation.role} ·{" "}
                  <span className={invitation.status === "pending" ? "text-accent" : "text-ink-faint"}>{invitation.status}</span>
                </span>
                {invitation.status === "pending" ? <RevokeInviteButton epoch={workspace.serverEpoch} membershipGeneration={workspace.membershipGeneration} workspaceId={workspaceId} invitationId={invitation.id} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
