"use client";

/**
 * Client helper for cookie-authenticated mutations: reads the readable
 * pb-team-csrf companion cookie and echoes it in the x-pb-team-csrf header
 * (double-submit; the server hashes and compares against the session row,
 * and additionally requires same-origin Origin when present).
 */

export const TEAM_CSRF_COOKIE = "pb-team-csrf";
export const TEAM_CSRF_HEADER = "x-pb-team-csrf";
export const TEAM_PROTOCOL_HEADER = "x-promptbranch-team-protocol";

export function readCsrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.split(/;\s*/).find((row) => row.startsWith(`${TEAM_CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(TEAM_CSRF_COOKIE.length + 1)) : "";
}

export interface TeamApiError {
  code: string;
  message: string;
  retryable?: boolean;
}

/** POSTs JSON to a team API route with CSRF + protocol headers. */
export async function teamPost<T = unknown>(
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: T | TeamApiError }> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TEAM_PROTOCOL_HEADER]: "1",
      [TEAM_CSRF_HEADER]: readCsrfToken(),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  let data: T | TeamApiError;
  try {
    data = (await response.json()) as T | TeamApiError;
  } catch {
    data = { code: "UNAVAILABLE", message: "Unexpected response" };
  }
  return { ok: response.ok, status: response.status, data };
}

/** Same shape for DELETE (also a cookie-authenticated mutation). */
export async function teamDelete<T = unknown>(path: string): Promise<{ ok: boolean; status: number; data: T | TeamApiError }> {
  const response = await fetch(path, {
    method: "DELETE",
    headers: {
      [TEAM_PROTOCOL_HEADER]: "1",
      [TEAM_CSRF_HEADER]: readCsrfToken(),
    },
    credentials: "same-origin",
  });
  let data: T | TeamApiError;
  try {
    data = (await response.json()) as T | TeamApiError;
  } catch {
    data = { code: "UNAVAILABLE", message: "Unexpected response" };
  }
  return { ok: response.ok, status: response.status, data };
}

export function errorMessage(result: { data: TeamApiError | unknown }): string {
  const data = result.data as TeamApiError | null;
  return data && typeof data === "object" && "message" in data ? String(data.message) : "Something went wrong";
}
