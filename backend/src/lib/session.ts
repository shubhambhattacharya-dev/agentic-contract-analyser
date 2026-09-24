import { randomUUID } from "node:crypto";

export const SESSION_COOKIE_NAME = "elcara_sid";

export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7;

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSessionId(): string {
  return randomUUID();
}

export function isValidSessionId(
  value: string,
): boolean {
  return UUID_V4_RE.test(value);
}

export function parseSessionFromHeader(
  cookieHeader: string | null,
): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const equalIndex = part.indexOf("=");

    if (equalIndex === -1) {
      continue;
    }

    const name = part
      .slice(0, equalIndex)
      .trim();

    const value = part
      .slice(equalIndex + 1)
      .trim();

    if (name !== SESSION_COOKIE_NAME) {
      continue;
    }

    try {
      const decoded = decodeURIComponent(value);

      if (!isValidSessionId(decoded)) {
        return null;
      }

      return decoded;
    } catch {
      return null;
    }
  }

  return null;
}

export function createSessionCookie(
  sessionId: string,
  isProduction: boolean,
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];

  if (isProduction) {
    /*
     * Frontend and backend deploy to different origins, so the session
     * cookie is cross-site from the browser's perspective. Lax cookies are
     * not sent on cross-origin XHR, which would silently reset the session
     * on every request. None + Secure is the only combination that works
     * for a cross-site SPA and stays secure.
     */
    parts.push("SameSite=None", "Secure");
  } else {
    parts.push("SameSite=Lax");
  }

  return parts.join("; ");
}