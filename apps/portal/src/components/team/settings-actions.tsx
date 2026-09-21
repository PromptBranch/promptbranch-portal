"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react/dist/ssr";
import { teamDelete, teamPost, type TeamApiError } from "@/lib/team/csrf-client";

/**
 * Owner/member settings actions. Every mutation goes through the commands
 * API under CSRF + origin enforcement; the UI disables last-owner removal
 * client-side, and the server enforces it regardless (tested separately).
 */

function useAction(epoch?: string) {
  const router = useRouter();
  const epochRef = useRef(epoch ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(path: string, body?: unknown, method: "POST" | "DELETE" = "POST") {
    setPending(true);
    setError(null);
    const result =
      method === "DELETE"
        ? await teamDelete(path)
        : await teamPost(path, body, { "x-promptbranch-team-epoch": epochRef.current });
    setPending(false);
    if (!result.ok) {
      setError((result.data as TeamApiError)?.message ?? "Action failed");
      return false;
    }
    router.refresh();
    return true;
  }
  return { pending, error, run, ErrorNote };
}

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-1.5 text-xs text-danger">
      {error}
    </p>
  );
}

export function RoleChangeForm(props: {
  epoch: string;
  membershipGeneration: string;
  workspaceId: string;
  userId: string;
  currentRole: string;
  expectedEntityVersion: number;
  isLastOwner: boolean;
  isSelf: boolean;
}) {
  const { pending, error, run, ErrorNote: Note } = useAction(props.epoch);
  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-label={`Change role for member ${props.userId}`}
        value={props.currentRole}
        disabled={pending || (props.isSelf && props.currentRole === "owner" && props.isLastOwner)}
        onChange={async (event) => {
          await run(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
            commandId: crypto.randomUUID(),
            membershipGeneration: props.membershipGeneration,
            operation: { type: "member.role", userId: props.userId, role: event.target.value, expectedEntityVersion: props.expectedEntityVersion },
          });
        }}
        className="rounded-md border border-line bg-panel px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
      >
        {["owner", "maintainer", "contributor", "viewer"].map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
      {props.isSelf && props.currentRole === "owner" ? (
        <span className="text-[10px] text-ink-faint">promote another owner first</span>
      ) : null}
      <Note error={error} />
    </div>
  );
}

export function RemoveMemberButton(props: { epoch: string; membershipGeneration: string; workspaceId: string; userId: string; expectedEntityVersion: number; isLastOwner: boolean }) {
  const { pending, error, run, ErrorNote: Note } = useAction(props.epoch);
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        disabled={pending || props.isLastOwner}
        title={props.isLastOwner ? "Transfer ownership before removing the last owner" : "Remove member"}
        onClick={() => run(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
          commandId: crypto.randomUUID(),
          membershipGeneration: props.membershipGeneration,
          operation: { type: "member.remove", userId: props.userId, expectedEntityVersion: props.expectedEntityVersion },
        })}
        className="rounded-md border border-line px-2 py-1 text-xs text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40"
      >
        Remove
      </button>
      <Note error={error} />
    </span>
  );
}

export function InviteForm(props: { epoch: string; membershipGeneration: string; workspaceId: string }) {
  const { pending, error, run, ErrorNote: Note } = useAction(props.epoch);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("contributor");
  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const ok = await run(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
          commandId: crypto.randomUUID(),
          membershipGeneration: props.membershipGeneration,
          operation: { type: "invitation.create", email, role },
        });
        if (ok) setEmail("");
      }}
    >
      <input
        type="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="teammate@example.com"
        aria-label="Invite email"
        className="min-w-[220px] flex-1 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <select
        aria-label="Invite role"
        value={role}
        onChange={(event) => setRole(event.target.value)}
        className="rounded-lg border border-line bg-panel px-2.5 py-2 text-sm text-ink focus:border-accent focus:outline-none"
      >
        {["maintainer", "contributor", "viewer"].map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending || email.length === 0} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-50">
        {pending ? "Inviting…" : "Invite"}
      </button>
      <div className="w-full">
        <Note error={error} />
      </div>
    </form>
  );
}

export function RevokeInviteButton(props: { epoch: string; membershipGeneration: string; workspaceId: string; invitationId: string }) {
  const { pending, run } = useAction(props.epoch);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => run(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
        commandId: crypto.randomUUID(),
        membershipGeneration: props.membershipGeneration,
        operation: { type: "invitation.revoke", invitationId: props.invitationId },
      })}
      className="rounded-md border border-line px-2 py-1 text-xs text-ink-dim transition-colors hover:text-danger"
    >
      Revoke
    </button>
  );
}

export function MintTokenForm(props: { workspaceId: string; canWriteScopes: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [days, setDays] = useState(30);
  const [scopes, setScopes] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const writeScopes = ["proposal:write", "note:write", "run:write"];

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        setSecret(null);
        const result = await teamPost<{ token?: string; secretAvailable?: boolean }>(`/api/team/v1/workspaces/${props.workspaceId}/agent-tokens`, {
          commandId: crypto.randomUUID(),
          name,
          scopes,
          expiresInDays: days,
        });
        setPending(false);
        const data = result.data as { token?: string; secretAvailable?: boolean; message?: string };
        if (!result.ok) {
          setError(data.message ?? "Could not mint the token");
          return;
        }
        if (data.token) {
          setSecret({ token: data.token });
          setName("");
        } else if (data.secretAvailable === false) {
          setError("This commandId was already used — the secret is shown only once. Revoke and mint a new token.");
        }
        router.refresh();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Token name (e.g. ci-agent)"
          aria-label="Token name"
          className="min-w-[200px] flex-1 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        <label className="flex items-center gap-1.5 text-xs text-ink-dim">
          expires in
          <input
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            aria-label="Expires in days"
            className="w-16 rounded-lg border border-line bg-panel px-2 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          />
          days
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        {writeScopes.map((scope) => (
          <label key={scope} className={`flex items-center gap-1 rounded-full px-2 py-1 ${scopes.includes(scope) ? "bg-accent-soft text-accent" : "bg-raised text-ink-dim"}`}>
            <input
              type="checkbox"
              checked={scopes.includes(scope)}
              disabled={!props.canWriteScopes}
              onChange={(event) =>
                setScopes((current) => (event.target.checked ? [...current, scope] : current.filter((s) => s !== scope)))
              }
              className="accent-[var(--pb-accent)]"
            />
            {scope}
          </label>
        ))}
        <span className="rounded-full border border-line px-2 py-1 text-ink-faint">catalog:read (always)</span>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {secret ? (
        <div className="rounded-lg border border-line bg-raised p-3">
          <p className="text-xs font-medium text-accent">Copy the token now — it is shown exactly once.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{secret.token}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(secret.token).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-dim hover:text-ink"
            >
              {copied ? <Check size={12} aria-hidden className="text-success" /> : <Copy size={12} aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : null}
      <button type="submit" disabled={pending || name.trim().length === 0} className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-50">
        {pending ? "Minting…" : "Mint token"}
      </button>
    </form>
  );
}

export function RevokeTokenButton(props: { epoch: string; workspaceId: string; tokenId: string }) {
  const { pending, run } = useAction(props.epoch);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => run(`/api/team/v1/workspaces/${props.workspaceId}/agent-tokens/${props.tokenId}`, undefined, "DELETE")}
      className="rounded-md border border-line px-2 py-1 text-xs text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
    >
      Revoke
    </button>
  );
}

export function RenameWorkspaceForm(props: { epoch: string; membershipGeneration: string; workspaceId: string; currentName: string; entityVersion: number }) {
  const { pending, error, run, ErrorNote: Note } = useAction(props.epoch);
  const [name, setName] = useState(props.currentName);
  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        await run(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
          commandId: crypto.randomUUID(),
          membershipGeneration: props.membershipGeneration,
          operation: { type: "workspace.rename", name, expectedEntityVersion: props.entityVersion },
        });
      }}
    >
      <input
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="Workspace name"
        className="min-w-[220px] flex-1 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
      />
      <button type="submit" disabled={pending} className="rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-ink-dim hover:bg-hover hover:text-ink disabled:opacity-50">
        {pending ? "Renaming…" : "Rename"}
      </button>
      <div className="w-full">
        <Note error={error} />
      </div>
    </form>
  );
}

export function DeleteWorkspaceForm(props: { epoch: string; membershipGeneration: string; workspaceId: string; name: string; entityVersion: number }) {
  const router = useRouter();
  const [confirmName, setConfirmName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-2.5"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await teamPost(`/api/team/v1/workspaces/${props.workspaceId}/commands`, {
          commandId: crypto.randomUUID(),
          membershipGeneration: props.membershipGeneration,
          operation: { type: "workspace.delete", confirmName, expectedEntityVersion: props.entityVersion },
        }, { "x-promptbranch-team-epoch": props.epoch });
        setPending(false);
        if (!result.ok) {
          setError((result.data as TeamApiError)?.message ?? "Could not delete the workspace");
          return;
        }
        router.push("/team");
        router.refresh();
      }}
    >
      <p className="text-xs text-ink-dim">
        Soft-disables immediately and purges data after 30 days. Requires a fresh sign-in (≤10 minutes) and typing the workspace name exactly.
      </p>
      <input
        required
        value={confirmName}
        onChange={(event) => setConfirmName(event.target.value)}
        placeholder={`type "${props.name}" to confirm`}
        aria-label="Confirm workspace name"
        className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-danger focus:outline-none"
      />
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending || confirmName !== props.name} className="rounded-lg bg-danger px-3.5 py-2 text-sm font-medium text-white hover:bg-danger-strong disabled:opacity-40">
        {pending ? "Deleting…" : "Delete workspace"}
      </button>
    </form>
  );
}
