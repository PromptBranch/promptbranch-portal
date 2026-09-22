/**
 * Origin normalization and pinning (C2). Team servers are HTTPS origins with
 * no path prefix; plain HTTP is accepted only on explicit loopback development
 * origins. Credentials are never accepted inside URLs, and the normalized
 * origin is the only authority for where bearer tokens may be sent.
 */
export class TeamOriginError extends Error {
  override readonly name = "TeamOriginError";

  constructor(message: string) {
    // Never echo the rejected input: it may contain embedded credentials.
    super(message);
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  return match.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Returns the canonical `scheme://host[:port]` origin or throws. Rejects
 * credentials, non-http(s) schemes, path prefixes, query strings and
 * fragments so a caller cannot smuggle routing or secrets into the pin.
 */
export function normalizeTeamOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new TeamOriginError("The team server address is not a valid URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TeamOriginError("Credentials in team server URLs are never accepted.");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new TeamOriginError(
      "Plain HTTP team origins are only allowed on loopback development addresses.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TeamOriginError("Team server origins must use HTTPS.");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new TeamOriginError("Team server origins must not carry a path, query or fragment.");
  }
  return url.origin;
}
