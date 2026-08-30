import { NextResponse, type NextRequest } from "next/server";

/**
 * Strict nonce CSP: Next.js parses the nonce out of the request CSP header
 * and applies it to its own hydration scripts, so no 'unsafe-inline' is
 * needed for scripts. Styles keep 'unsafe-inline' (React inline style
 * attributes and Tailwind's generated <style> tags require it); that is
 * the documented Next.js CSP trade-off, not an accident.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  // Dev-only: react-refresh evaluates module code with `eval`, so HMR dies
  // (and client components never hydrate) under a strict CSP. Production
  // stays strict — react-refresh is not part of production bundles.
  const scriptSrc =
    process.env.NODE_ENV === "development"
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|llms.txt).*)"],
};
