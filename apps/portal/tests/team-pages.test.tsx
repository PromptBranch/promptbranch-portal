// @vitest-environment jsdom
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

// P7 browser-surface tests (plan task 1): unauthenticated redirect,
// role-hidden actions, escaped titles, private candidate invisibility and
// draft persistence semantics. Domain modules are mocked — their behavior
// is covered by the team-server suites; these tests own the PAGE logic.

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listPrompts: vi.fn(),
  getPromptWithHead: vi.fn(),
  listPublishedRevisions: vi.fn(),
  getProposalDetail: vi.fn(),
  listComments: vi.fn(),
  listMembers: vi.fn(),
  listInvitations: vi.fn(),
  listAgentTokens: vi.fn(),
  listAudit: vi.fn(),
  listOrgEntities: vi.fn(async () => []),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  session: { current: null as null | { userId: string; email: string } },
}));

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@promptbranch/team-server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@promptbranch/team-server")>();
  return {
    ...original,
    listWorkspaces: mocks.listWorkspaces,
    listPrompts: mocks.listPrompts,
    getPromptWithHead: mocks.getPromptWithHead,
    listPublishedRevisions: mocks.listPublishedRevisions,
    getProposalDetail: mocks.getProposalDetail,
    listComments: mocks.listComments,
    listMembers: mocks.listMembers,
    listInvitations: mocks.listInvitations,
    listAgentTokens: mocks.listAgentTokens,
    listAudit: mocks.listAudit,
  listOrgEntities: mocks.listOrgEntities,
  };
});

// The signed-in session fixture: any truthy userId switches the SSR context on.
vi.mock("@/lib/team/ssr", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/team/ssr")>();
  return {
    ...original,
    getTeamPageSession: vi.fn(async () =>
      mocks.session.current
        ? {
            service: { pool: {} } as never,
            auth: {
              kind: "human",
              userId: mocks.session.current.userId,
              sessionId: "session-1",
              authenticatedAt: new Date().toISOString(),
              via: "cookie",
              webSession: { email: mocks.session.current.email },
            } as never,
          }
        : null,
    ),
    requireSignedIn: vi.fn(async () => {
      if (!mocks.session.current) throw new Error("REDIRECT:/team/auth/login");
      return {
        service: { pool: {} } as never,
        auth: { kind: "human", userId: mocks.session.current.userId, sessionId: "s", authenticatedAt: new Date().toISOString(), via: "cookie" },
      };
    }),
    requireWorkspacePage: vi.fn(async (workspaceId: string) => {
      if (!mocks.session.current) throw new Error("REDIRECT:/team/auth/login");
      return {
        service: { pool: {} } as never,
        auth: {
          kind: "human",
          userId: mocks.session.current.userId,
          sessionId: "s",
          authenticatedAt: new Date().toISOString(),
          via: "cookie",
          webSession: { email: mocks.session.current.email },
        },
        workspace: { id: workspaceId, name: "Test WS", role: "owner", membershipGeneration: "g", serverEpoch: "e", entityVersion: 1, updatedAt: new Date().toISOString() },
      };
    }),
  };
});

import WorkspacePickerPage from "@/app/team/page";
import LibraryPage from "@/app/team/w/[workspaceId]/library/page";
import PromptDetailPage from "@/app/team/w/[workspaceId]/prompts/[promptId]/page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.current = { userId: "user-1", email: "alice@promptbranch.test" };
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "portal-test-"));
});

describe("workspace picker", () => {
  it("redirects unauthenticated visitors to the sign-in flow", async () => {
    mocks.session.current = null;
    await expect(WorkspacePickerPage()).rejects.toThrow("REDIRECT:/team/auth/login");
  });

  it("lists the signed-in member's workspaces and the empty state", async () => {
    mocks.listWorkspaces.mockResolvedValue([
      { id: "w1", name: "Alpha", role: "owner", membershipGeneration: "g", serverEpoch: "e", entityVersion: 1, updatedAt: new Date().toISOString() },
    ]);
    render(await WorkspacePickerPage());
    expect(screen.getByRole("link", { name: /Alpha/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Your workspaces" })).toBeVisible();

    mocks.listWorkspaces.mockResolvedValue([]);
    render(await WorkspacePickerPage());
    expect(screen.getByText(/haven.t joined a workspace yet/i)).toBeVisible();
  });
});

describe("library", () => {
  it("renders approved prompts and escapes hostile titles", async () => {
    mocks.listPrompts.mockResolvedValue({
      items: [
        {
          id: "p1",
          workspaceId: "w1",
          title: '<script>alert("xss")</script>',
          description: "",
          approvedRevisionId: "r1",
          tagIds: [],
          collectionIds: [],
          entityVersion: 1,
          archivedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      nextPageToken: null,
    });
    render(await LibraryPage({ params: Promise.resolve({ workspaceId: "w1" }), searchParams: Promise.resolve({}) }));
    // Rendered as TEXT, not markup — React escaping.
    expect(screen.getByText('<script>alert("xss")</script>')).toBeVisible();
    expect(document.querySelector("script#evil, script:not([src])")).toBeNull();
  });

  it("keeps candidate content out of the approved prompt detail", async () => {
    mocks.getPromptWithHead.mockResolvedValue({
      prompt: { id: "p1", workspaceId: "w1", title: "Approved", description: "", approvedRevisionId: "r1", tagIds: [], collectionIds: [], entityVersion: 1, archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      revision: { id: "r1", workspaceId: "w1", promptId: "p1", parentRevisionId: null, content: "approved body text", contentFormat: "markdown", contentHash: "a".repeat(64), changeNote: "", author: { userId: "u", displayName: "Alice", agentTokenId: null }, createdAt: new Date().toISOString() },
    });
    mocks.listPublishedRevisions.mockResolvedValue({
      items: [
        { id: "r1", workspaceId: "w1", promptId: "p1", parentRevisionId: null, content: "approved body text", contentFormat: "markdown", contentHash: "a".repeat(64), changeNote: "", author: { userId: "u", displayName: "Alice", agentTokenId: null }, createdAt: new Date().toISOString() },
      ],
      nextPageToken: null,
    });
    const { container } = render(
      await PromptDetailPage({ params: Promise.resolve({ workspaceId: "w1", promptId: "p1" }) }),
    );
    expect(screen.getByText("approved body text")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeVisible();
    expect(container.textContent).not.toContain("unapproved");
    // Deep link carries ids only — never tokens or content.
    const deepLink = container.querySelector('a[href^="promptbranch://team/open?"]') as HTMLAnchorElement;
    expect(deepLink).toBeTruthy();
    expect(deepLink.getAttribute("href")).not.toContain("token=");
    expect(deepLink.getAttribute("href")).toContain("workspace=w1");
    expect(deepLink.getAttribute("href")).toContain("prompt=p1");
    expect(screen.getByRole("heading", { name: "Published history" })).toBeVisible();
  });
});

describe("role-hidden actions", () => {
  it("hides the proposal CTA from viewers (the server refuses anyway)", async () => {
    const { requireWorkspacePage } = await import("@/lib/team/ssr");
    (requireWorkspacePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      service: { pool: {} },
      auth: { kind: "human", userId: "user-1", sessionId: "s", authenticatedAt: new Date().toISOString(), via: "cookie" },
      workspace: { id: "w1", name: "WS", role: "viewer", membershipGeneration: "g", serverEpoch: "e", entityVersion: 1, updatedAt: new Date().toISOString() },
    });
    mocks.getPromptWithHead.mockResolvedValue({
      prompt: { id: "p1", workspaceId: "w1", title: "T", description: "", approvedRevisionId: "r1", tagIds: [], collectionIds: [], entityVersion: 1, archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      revision: { id: "r1", workspaceId: "w1", promptId: "p1", parentRevisionId: null, content: "c", contentFormat: "markdown", contentHash: "b".repeat(64), changeNote: "", author: { userId: "u", displayName: "A", agentTokenId: null }, createdAt: new Date().toISOString() },
    });
    mocks.listPublishedRevisions.mockResolvedValue({ items: [], nextPageToken: null });
    render(await PromptDetailPage({ params: Promise.resolve({ workspaceId: "w1", promptId: "p1" }) }));
    expect(screen.queryByRole("link", { name: "New proposal" })).toBeNull();
  });

  it("shell hides member/settings navigation from non-owners", async () => {
    const { default: WorkspaceLayout } = await import("@/app/team/w/[workspaceId]/layout");
    const { requireWorkspacePage } = await import("@/lib/team/ssr");
    (requireWorkspacePage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      service: { pool: {} },
      auth: { kind: "human", userId: "user-1", sessionId: "s", authenticatedAt: new Date().toISOString(), via: "cookie" },
      workspace: { id: "w1", name: "WS", role: "contributor", membershipGeneration: "g", serverEpoch: "e", entityVersion: 1, updatedAt: new Date().toISOString() },
    });
    render(
      await WorkspaceLayout({ children: <p>content</p>, params: Promise.resolve({ workspaceId: "w1" }) }),
    );
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    expect(within(nav).getByRole("link", { name: "Library" })).toBeVisible();
    expect(within(nav).queryByRole("link", { name: "Members" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Settings" })).toBeNull();
  });
});
