import createDOMPurify, { type Config } from "dompurify";

const RENDERED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "ul",
  "var",
];

const RENDERED_ATTRIBUTES = [
  "abbr",
  "align",
  "alt",
  "aria-describedby",
  "aria-label",
  "aria-labelledby",
  "checked",
  "cite",
  "class",
  "colspan",
  "data-footnote-backref",
  "data-footnote-ref",
  "data-footnotes",
  "datetime",
  "dir",
  "disabled",
  "headers",
  "height",
  "href",
  "hreflang",
  "id",
  "itemprop",
  "itemscope",
  "itemtype",
  "lang",
  "longdesc",
  "open",
  "rowspan",
  "scope",
  "span",
  "src",
  "start",
  "summary",
  "tabindex",
  "title",
  "type",
  "width",
];

const RENDERED_CONFIG = {
  ALLOWED_TAGS: RENDERED_TAGS,
  ALLOWED_ATTR: RENDERED_ATTRIBUTES,
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
} satisfies Config;

const SOURCE_CONFIG = {
  ALLOWED_TAGS: ["pre", "code", "span"],
  ALLOWED_ATTR: ["class", "tabindex"],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
} satisfies Config;

const LINK_PROTOCOLS = new Set(["http:", "https:", "irc:", "ircs:", "mailto:", "xmpp:"]);
const IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

function normalizedUrl(value: string, baseUrl: URL, protocols: ReadonlySet<string>): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value, baseUrl);
    return protocols.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The API sanitizes before highlighting; repeat a strict, independent check
 * here because this HTML executes under the embedding site's origin.
 */
export function sanitizeEmbedHtml(
  document: Document,
  renderedHtml: string,
  sourceHtml: string,
  pageUrl: string,
): { rendered: DocumentFragment; source: DocumentFragment } {
  const view = document.defaultView;
  let baseUrl: URL;
  try {
    baseUrl = new URL(pageUrl);
  } catch {
    return {
      rendered: document.createDocumentFragment(),
      source: document.createDocumentFragment(),
    };
  }
  if (!view) {
    return {
      rendered: document.createDocumentFragment(),
      source: document.createDocumentFragment(),
    };
  }

  const purifier = createDOMPurify(view);
  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    const protocols = data.attrName === "href"
      ? LINK_PROTOCOLS
      : data.attrName === "src"
        ? IMAGE_PROTOCOLS
        : undefined;
    if (!protocols) return;
    const value = normalizedUrl(data.attrValue, baseUrl, protocols);
    if (value) data.attrValue = value;
    else data.keepAttr = false;
  });
  const rendered = purifier.sanitize(renderedHtml, RENDERED_CONFIG) as DocumentFragment;
  const source = purifier.sanitize(sourceHtml, SOURCE_CONFIG) as DocumentFragment;

  // GFM task-list checkboxes are the only interactive-looking element emitted
  // by the server schema. Keep them inert even if an API regression omits it.
  for (const input of rendered.querySelectorAll("input")) {
    if (input.getAttribute("type") !== "checkbox") {
      input.remove();
      continue;
    }
    input.setAttribute("disabled", "");
  }

  return { rendered, source };
}
