/**
 * Links that open an entry screen: an invite (E08), a password reset (E09), or a Jam (D05, D07).
 * The server shares them as web links, `<origin>/invite/<code>`, `<origin>/reset/<token>`, and
 * `<origin>/jam/<code>`, which name the server too; the app's own `music://invite/<code>` and the
 * like name none and belong to the connected server, unless they carry `?server=<address>`. Parsed with patterns rather than
 * `URL`, whose query support React Native only partly implements.
 */
import { originCandidates } from "./server";
import type { ServerOrigin } from "./server";

/** Which entry screen a link opens. */
type EntryKind = "invite" | "reset" | "jam";

/** An invite code or reset token, and the server address the link names, if any. */
export interface EntryLink {
  readonly kind: EntryKind;
  readonly secret: string;
  /** The server as the link names it, possibly without a scheme; null for the connected one. */
  readonly server: string | null;
}

const SECRET = /^[\w-]{1,200}$/u;

const APP_LINK =
  /^music:\/{2,3}(?<kind>invite|reset|jam)\/(?<secret>[^/?#]+)\/?(?:\?(?<query>[^#]*))?(?:#.*)?$/iu;

const PATH_LINK = /^\/(?<kind>invite|reset|jam)\/(?<secret>[^/?#]+)\/?(?:[?#].*)?$/iu;

const WEB_LINK =
  /^(?<base>(?:https?:\/\/)?[^/?#\s]+(?:\/[^?#\s]*?)?)\/(?<kind>invite|reset|jam)\/(?<secret>[^/?#\s]+)\/?(?:[?#].*)?$/iu;

const decode = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/** The `server` query parameter's value, if present. */
const serverParam = (query: string | undefined): string | null => {
  for (const pair of (query ?? "").split("&")) {
    const [key = "", ...rest] = pair.split("=");

    if (key === "server") return decode(rest.join("="));
  }

  return null;
};

const makeLink = (
  groups: Partial<Record<string, string>> | undefined,
  server: string | null,
): EntryLink | null => {
  const kind = groups?.["kind"]?.toLowerCase();
  const secret = decode(groups?.["secret"] ?? "");

  if (
    (kind !== "invite" && kind !== "reset" && kind !== "jam") ||
    secret === null ||
    !SECRET.test(secret)
  ) {
    return null;
  }

  return { kind, secret, server };
};

/** The entry link in opened or pasted text, or null when the text isn't one. */
export const parseEntryLink = (text: string): EntryLink | null => {
  const trimmed = text.trim();

  if (/^music:/iu.test(trimmed)) {
    const groups = APP_LINK.exec(trimmed)?.groups;

    return makeLink(groups, serverParam(groups?.["query"]));
  }

  if (trimmed.startsWith("/")) return makeLink(PATH_LINK.exec(trimmed)?.groups, null);

  const groups = WEB_LINK.exec(trimmed)?.groups;
  const base = groups?.["base"] ?? "";

  return originCandidates(base) === null ? null : makeLink(groups, base);
};

/**
 * Each link's screen signed out and signed in. Invites and resets are for people signed out; a Jam
 * link opens its guest screen (D07) signed out, and its invite (D05) signed in.
 */
const SCREENS = {
  invite: { signedOut: "/invite/", signedIn: null },
  reset: { signedOut: "/reset/", signedIn: null },
  jam: { signedOut: "/jam-guest/", signedIn: "/jam/" },
} as const satisfies Record<EntryKind, { signedOut: string; signedIn: string | null }>;

/** The route the link opens, or null when it has nothing to show someone signed in. */
export const entryPath = (link: EntryLink, signedIn: boolean): string | null => {
  const screen = SCREENS[link.kind][signedIn ? "signedIn" : "signedOut"];

  return screen === null ? null : `${screen}${encodeURIComponent(link.secret)}`;
};

/** Whether the link belongs to the server at `origin`: it names that server, or none. */
export const linkIsFor = (link: EntryLink, origin: ServerOrigin): boolean =>
  link.server === null || (originCandidates(link.server)?.includes(origin) ?? false);
