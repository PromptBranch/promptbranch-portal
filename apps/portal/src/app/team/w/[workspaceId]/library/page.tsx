import Link from "next/link";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";
import { listOrgEntities, listPrompts } from "@promptbranch/team-server";
import { SeedPromptForm } from "@/components/team/seed-prompt-form";
import { requireWorkspacePage } from "@/lib/team/ssr";

// Approved library browse/search. Only published content is queried; tags
// and collections filter via junction EXISTS. Empty and no-match states are
// first-class.

export default async function LibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ q?: string; tagId?: string; collectionId?: string; archived?: string }>;
}) {
  const { workspaceId } = await params;
  const { service, workspace } = await requireWorkspacePage(workspaceId);
  const query = await searchParams;
  const showArchived = query.archived === "true";

  const [result, tags, collections] = await Promise.all([
    listPrompts(service.pool, workspaceId, {
      q: query.q,
      tagId: query.tagId,
      collectionId: query.collectionId,
      archived: showArchived,
    }),
    listOrgEntities(service.pool, "tag", workspaceId),
    listOrgEntities(service.pool, "collection", workspaceId),
  ]);
  const tagById = new Map(tags.map((tag) => [tag.id, tag.name]));
  const collectionById = new Map(collections.map((c) => [c.id, c.name]));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight text-ink">{showArchived ? "Archived prompts" : "Library"}</h1>
        <form action="" method="get" className="flex items-center gap-2" role="search">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
            <MagnifyingGlass size={14} aria-hidden className="text-ink-faint" />
            <input
              type="search"
              name="q"
              defaultValue={query.q ?? ""}
              placeholder="Search approved prompts…"
              maxLength={200}
              aria-label="Search approved prompts"
              className="w-64 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </div>
          {query.tagId ? <input type="hidden" name="tagId" value={query.tagId} /> : null}
          <button type="submit" className="rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink-dim hover:bg-hover hover:text-ink">
            Search
          </button>
        </form>
      </div>

      {["owner", "maintainer"].includes(workspace.role) && !showArchived ? (
        <div className="mt-4 rounded-xl border border-line bg-panel p-4">
          <SeedPromptForm workspaceId={workspaceId} membershipGeneration={workspace.membershipGeneration} epoch={workspace.serverEpoch} />
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
        <FilterChip href={`/team/w/${workspaceId}/library${query.q ? `?q=${encodeURIComponent(query.q)}` : ""}`} active={!query.tagId && !query.collectionId}>
          All
        </FilterChip>
        {tags.map((tag) => (
          <FilterChip key={tag.id} href={`/team/w/${workspaceId}/library?tagId=${tag.id}${query.q ? `&q=${encodeURIComponent(query.q)}` : ""}`} active={query.tagId === tag.id}>
            {tag.name}
          </FilterChip>
        ))}
        {collections.map((collection) => (
          <FilterChip key={collection.id} href={`/team/w/${workspaceId}/library?collectionId=${collection.id}${query.q ? `&q=${encodeURIComponent(query.q)}` : ""}`} active={query.collectionId === collection.id}>
            {collection.name}
          </FilterChip>
        ))}
        <FilterChip href={`/team/w/${workspaceId}/library?archived=true`} active={showArchived} muted>
          Archived
        </FilterChip>
      </div>

      {result.items.length === 0 ? (
        <p className="mt-8 rounded-xl border border-line bg-panel p-6 text-sm text-ink-dim">
          {query.q || query.tagId || query.collectionId
            ? "No approved prompts match this filter."
            : showArchived
              ? "No archived prompts."
              : "Nothing has been published yet. A maintainer can seed the first prompt, and every later change arrives through proposals."}
        </p>
      ) : (
        <ul className="mt-6 space-y-2.5">
          {result.items.map((prompt) => (
            <li key={prompt.id}>
              <Link
                href={`/team/w/${workspaceId}/prompts/${prompt.id}`}
                className="block rounded-xl border border-line bg-panel px-4 py-3.5 transition-colors hover:border-line-strong hover:bg-hover"
              >
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{prompt.title}</span>
                  {prompt.archivedAt ? (
                    <span className="rounded-full border border-line px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-faint">
                      archived
                    </span>
                  ) : null}
                </span>
                {prompt.description ? <span className="mt-0.5 block truncate text-xs text-ink-dim">{prompt.description}</span> : null}
                <span className="mt-1.5 flex flex-wrap gap-1.5">
                  {prompt.tagIds.map((tagId) => (
                    <span key={tagId} className="rounded-full border border-line bg-panel px-2.5 py-0.5 text-[10px] font-medium text-ink-dim">
                      {tagById.get(tagId) ?? "tag"}
                    </span>
                  ))}
                  {prompt.collectionIds.map((collectionId) => (
                    <span key={collectionId} className="rounded-full border border-line bg-panel px-2.5 py-0.5 text-[10px] font-medium text-accent">
                      {collectionById.get(collectionId) ?? "collection"}
                    </span>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip(props: { href: string; active: boolean; muted?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={props.href}
      className={`rounded-full px-2.5 py-1 transition-colors ${
        props.active ? "bg-accent-soft text-accent" : props.muted ? "border border-line text-ink-faint hover:text-ink-dim" : "bg-raised text-ink-dim hover:text-ink"
      }`}
    >
      {props.children}
    </Link>
  );
}
