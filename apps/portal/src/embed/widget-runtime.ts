import { sanitizeEmbedHtml } from "./sanitize-html";

export interface EmbedResponse {
  formatVersion: 1;
  id: string;
  url: string;
  title: string;
  description?: string;
  tags: string[];
  markdown: string;
  contentHtml: string;
  sourceHtml: string;
}

interface EmbedRuntimeOptions {
  document: Document;
  portalOrigin: string;
  assetBaseUrl: string;
  fetch: typeof fetch;
}

const EMBED_SELECTOR = "[data-promptbranch-embed]";
const SNAPSHOT_PATH = /^\/p\/([A-Za-z0-9_-]{21})$/;
const INSTALLED_KEY = "__pbEmbedCleanup";
type EmbedCleanup = () => void;
type EmbedCleanupRegistry = Map<string, EmbedCleanup>;

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function shareLocation(value: string, portalOrigin: string): { id: string; url: URL } | null {
  try {
    const url = new URL(value);
    const origin = new URL(portalOrigin).origin;
    const match = url.pathname.match(SNAPSHOT_PATH);
    if (
      !match ||
      url.origin !== origin ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return { id: match[1]!, url };
  } catch {
    return null;
  }
}

function isEmbedResponse(value: unknown, expectedId: string, portalOrigin: string): value is EmbedResponse {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  if (
    data.formatVersion !== 1 ||
    data.id !== expectedId ||
    typeof data.title !== "string" ||
    (data.description !== undefined && typeof data.description !== "string") ||
    !Array.isArray(data.tags) ||
    !data.tags.every((tag) => typeof tag === "string") ||
    typeof data.markdown !== "string" ||
    typeof data.contentHtml !== "string" ||
    typeof data.sourceHtml !== "string"
  ) {
    return false;
  }
  const location = shareLocation(String(data.url), portalOrigin);
  return Boolean(location && location.id === expectedId);
}

function normalizeTheme(value: string | null): "auto" | "light" | "dark" {
  return value === "light" || value === "dark" ? value : "auto";
}

function renderUnavailable(shadow: ShadowRoot, pageUrl: string, document: Document): void {
  const surface = element(document, "div", "pb-embed-surface");
  const box = element(document, "section", "pb-embed-unavailable");
  box.setAttribute("role", "status");
  const message = element(document, "p");
  message.textContent = "This shared prompt is unavailable.";
  const link = element(document, "a");
  link.href = pageUrl;
  link.textContent = "View full prompt";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  box.append(message, link);
  surface.append(box);
  shadow.append(surface);
}

function renderPrompt(
  shadow: ShadowRoot,
  prompt: EmbedResponse,
  pageUrl: string,
  document: Document,
): void {
  const surface = element(document, "div", "pb-embed-surface");
  const frame = element(document, "article", "code-box pb-embed-window");
  frame.dataset.view = "rendered";
  frame.dataset.pbEmbedWindow = "";
  // Opt-in styling hooks let the landing demo align its window with the code
  // sample while ordinary embeds retain their own natural content sizing.
  frame.setAttribute("part", "window");
  frame.setAttribute("aria-label", `Shared prompt: ${prompt.title}`);

  const bar = element(document, "header", "code-box-bar pb-embed-bar");
  const dots = element(document, "span", "code-box-dots");
  dots.setAttribute("aria-hidden", "true");
  dots.append(element(document, "i"), element(document, "i"), element(document, "i"));
  const title = element(document, "span", "code-box-title");
  title.setAttribute("part", "title");
  title.textContent = prompt.title;
  title.title = prompt.title;

  const controls = element(document, "div", "pb-embed-controls");
  const renderedButton = element(document, "button", "pb-embed-control");
  renderedButton.type = "button";
  renderedButton.textContent = "Rendered";
  renderedButton.dataset.viewButton = "rendered";
  renderedButton.setAttribute("aria-label", "Rendered prompt view");
  renderedButton.setAttribute("aria-pressed", "true");
  const sourceButton = element(document, "button", "pb-embed-control");
  sourceButton.type = "button";
  sourceButton.textContent = "Source";
  sourceButton.dataset.viewButton = "source";
  sourceButton.setAttribute("aria-label", "Source Markdown view");
  sourceButton.setAttribute("aria-pressed", "false");
  const copyButton = element(document, "button", "pb-embed-control");
  copyButton.type = "button";
  copyButton.textContent = "Copy";
  copyButton.dataset.copyMarkdown = "";
  copyButton.setAttribute("aria-label", "Copy prompt Markdown");
  controls.append(renderedButton, sourceButton, copyButton);
  bar.append(dots, title, controls);

  const renderedPane = element(document, "div", "code-box-pane");
  renderedPane.dataset.pane = "rendered";
  renderedPane.setAttribute("part", "content");
  renderedPane.classList.add("pb-embed-scroll");
  renderedPane.setAttribute("role", "region");
  renderedPane.setAttribute("aria-label", "Rendered prompt content");
  renderedPane.tabIndex = 0;
  const renderedContent = element(document, "div", "md");

  const sourcePane = element(document, "div", "code-box-pane");
  sourcePane.dataset.pane = "source";
  sourcePane.setAttribute("part", "content");
  sourcePane.classList.add("pb-embed-scroll");
  sourcePane.setAttribute("role", "region");
  sourcePane.setAttribute("aria-label", "Source Markdown content");
  sourcePane.tabIndex = 0;
  const sanitized = sanitizeEmbedHtml(document, prompt.contentHtml, prompt.sourceHtml, pageUrl);
  renderedContent.append(sanitized.rendered);
  renderedPane.append(renderedContent);
  const sourceContent = element(document, "div", "source-view");
  sourceContent.append(sanitized.source);
  sourcePane.append(sourceContent);
  frame.append(bar, renderedPane, sourcePane);

  const footer = element(document, "footer", "pb-embed-footer");
  const details = element(document, "div", "pb-embed-details");
  if (prompt.description) {
    const description = element(document, "span", "pb-embed-description");
    description.dataset.promptDescription = "";
    description.textContent = prompt.description;
    details.append(description);
  }
  if (prompt.tags.length > 0) {
    const tags = element(document, "span", "pb-embed-tags");
    tags.textContent = prompt.tags.join(" · ");
    details.append(tags);
  }
  if (details.childNodes.length > 0) footer.append(details);
  const links = element(document, "nav", "pb-embed-actions");
  links.setAttribute("aria-label", "Prompt actions");
  const openLink = element(document, "a", "pb-embed-link pb-embed-open-link");
  openLink.href = `promptbranch://import?url=${encodeURIComponent(pageUrl)}`;
  openLink.dataset.openPromptbranch = "";
  const openIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  openIcon.setAttribute("viewBox", "0 0 24 24");
  openIcon.setAttribute("width", "15");
  openIcon.setAttribute("height", "15");
  openIcon.setAttribute("fill", "none");
  openIcon.setAttribute("stroke", "currentColor");
  openIcon.setAttribute("stroke-width", "2");
  openIcon.setAttribute("stroke-linecap", "round");
  openIcon.setAttribute("stroke-linejoin", "round");
  openIcon.setAttribute("aria-hidden", "true");
  const openIconPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  openIconPath.setAttribute("d", "M7 17 17 7M7 7h10v10");
  openIcon.append(openIconPath);
  const openLabel = element(document, "span");
  openLabel.textContent = "Open in PromptBranch";
  openLink.append(openLabel, openIcon);
  const fullLink = element(document, "a", "pb-embed-link pb-embed-secondary-link");
  fullLink.href = pageUrl;
  fullLink.dataset.viewFull = "";
  fullLink.textContent = "View full prompt";
  fullLink.target = "_blank";
  fullLink.rel = "noopener noreferrer";
  links.append(openLink, fullLink);
  footer.append(links);

  const status = element(document, "p", "pb-embed-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "";
  surface.append(frame, footer, status);
  shadow.append(surface);

  const setView = (view: "rendered" | "source") => {
    frame.dataset.view = view;
    renderedButton.setAttribute("aria-pressed", String(view === "rendered"));
    sourceButton.setAttribute("aria-pressed", String(view === "source"));
  };
  renderedButton.addEventListener("click", () => setView("rendered"));
  sourceButton.addEventListener("click", () => setView("source"));
  copyButton.addEventListener("click", () => {
    const clipboard = document.defaultView?.navigator.clipboard;
    if (!clipboard) {
      status.textContent = "Clipboard access is unavailable. Select Source to copy manually.";
      return;
    }
    void clipboard.writeText(prompt.markdown).then(
      () => { status.textContent = "Copied Markdown."; },
      () => { status.textContent = "Copy failed. Select Source to copy manually."; },
    );
  });
}

function mountEmbed(host: HTMLElement, options: EmbedRuntimeOptions, id: string, pageUrl: URL): () => void {
  if (host.shadowRoot || host.dataset.pbEmbedMounted) return () => undefined;
  host.dataset.pbEmbedMounted = "loading";
  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = element(options.document, "link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = `${options.assetBaseUrl.replace(/\/+$/, "")}/embed.css`;
  shadow.append(stylesheet);

  const theme = normalizeTheme(host.getAttribute("data-promptbranch-theme"));
  const media = options.document.defaultView?.matchMedia?.("(prefers-color-scheme: light)");
  const updateTheme = () => {
    host.dataset.pbThemeResolved = theme === "auto" ? (media?.matches ? "light" : "dark") : theme;
  };
  updateTheme();
  if (theme === "auto") media?.addEventListener?.("change", updateTheme);

  void options.fetch(`${options.portalOrigin.replace(/\/+$/, "")}/api/embeds/${id}`, {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    redirect: "error",
    headers: { Accept: "application/json" },
  }).then(async (response) => {
    if (!response.ok) throw new Error("embed unavailable");
    const body: unknown = await response.json();
    if (!isEmbedResponse(body, id, options.portalOrigin)) throw new Error("invalid embed response");
    const tokenStylesheet = element(options.document, "link");
    tokenStylesheet.rel = "stylesheet";
    tokenStylesheet.crossOrigin = "anonymous";
    tokenStylesheet.href = `${options.portalOrigin.replace(/\/+$/, "")}/api/embeds/${id}/styles.css`;
    shadow.append(tokenStylesheet);
    host.dataset.pbEmbedMounted = "ready";
    renderPrompt(shadow, body, pageUrl.href, options.document);
  }).catch(() => {
    host.dataset.pbEmbedMounted = "unavailable";
    renderUnavailable(shadow, pageUrl.href, options.document);
  });

  return () => {
    if (theme === "auto") media?.removeEventListener?.("change", updateTheme);
  };
}

/** Keep one observer per portal origin so duplicate scripts are idempotent
    without blocking separate portals embedded on the same page. */
export function initializeEmbeds(options: EmbedRuntimeOptions): () => void {
  const browserWindow = options.document.defaultView;
  if (!browserWindow) return () => undefined;
  const view = browserWindow as Window & {
    [INSTALLED_KEY]?: EmbedCleanupRegistry | EmbedCleanup;
  };
  const installed = view[INSTALLED_KEY];
  const cleanups = installed instanceof Map ? installed : new Map<string, EmbedCleanup>();
  if (typeof installed === "function") installed();
  const portalOrigin = new URL(options.portalOrigin).origin;
  const existing = cleanups.get(portalOrigin);
  if (existing) return existing;

  const themeCleanups: Array<() => void> = [];
  const mountIn = (node: ParentNode) => {
    const matches: HTMLElement[] = [];
    if (node instanceof browserWindow.Element && node.matches(EMBED_SELECTOR)) {
      matches.push(node as HTMLElement);
    }
    matches.push(...node.querySelectorAll<HTMLElement>(EMBED_SELECTOR));
    for (const host of matches) {
      if (host.dataset.pbEmbedMounted || host.shadowRoot) continue;
      const location = shareLocation(host.getAttribute("data-promptbranch-embed") ?? "", portalOrigin);
      if (location) themeCleanups.push(mountEmbed(host, options, location.id, location.url));
    }
  };

  mountIn(options.document);
  const Observer = browserWindow.MutationObserver;
  const observer = new Observer((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === browserWindow.Node.ELEMENT_NODE) mountIn(node as ParentNode);
      }
    }
  });
  observer.observe(options.document.documentElement, { childList: true, subtree: true });

  const cleanup = () => {
    observer.disconnect();
    for (const stopListening of themeCleanups) stopListening();
    cleanups.delete(portalOrigin);
    if (cleanups.size === 0 && view[INSTALLED_KEY] === cleanups) delete view[INSTALLED_KEY];
  };
  cleanups.set(portalOrigin, cleanup);
  view[INSTALLED_KEY] = cleanups;
  return cleanup;
}
