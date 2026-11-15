/**
 * Invite and password reset links. The account client's links are `<server>/invite#<code>` and
 * `<server>/reset#<code>`, the code in the fragment so no request carries it (ADR 0020); the
 * app's own deep links are `music://invite/<code>?server=<server>` and the same for `reset`. Path
 * links, `<server>/invite/<code>`, are refused as the account client refuses them. Parsed
 * with patterns rather than `URL`, whose query support React Native only partly implements.
 */
import { normalizeServerUrl } from "@media/mobile-core/server";

import { sameServer } from "./server";

/** Which entry screen a link opens. */
type EntryKind = "invite" | "reset";

export interface EntryLink {
  readonly kind: EntryKind;
  readonly secret: string;
  /** The server as the link names it, possibly without a scheme; null for the connected one. */
  readonly server: string | null;
}

const SECRET = /^[\w.-]{1,200}$/u;

const APP_LINK =
  /^music:\/{2,3}(?<kind>invite|reset)\/(?<secret>[^/?#]+)\/?(?:\?(?<query>[^#]*))?(?:#.*)?$/iu;

const PATH_LINK = /^\/(?<kind>invite|reset)\/(?<secret>[^/?#]+)\/?(?:[?#].*)?$/iu;

const WEB_LINK =
  /^(?<base>(?:https?:\/\/)?[^/?#\s]+(?:\/[^?#\s]*?)?)\/(?<kind>invite|reset)\/?#(?<secret>[^#\s]+)$/iu;

const decode = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

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

  if ((kind !== "invite" && kind !== "reset") || secret === null || !SECRET.test(secret)) {
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

  return normalizeServerUrl(base) === null ? null : makeLink(groups, base);
};

const SCREENS = {
  invite: "/invite/",
  reset: "/reset/",
} as const satisfies Record<EntryKind, string>;

/** The route the link opens; both open only while signed out. */
export const entryPath = (link: EntryLink): string =>
  `${SCREENS[link.kind]}${encodeURIComponent(link.secret)}`;

export const linkIsFor = (link: EntryLink, mediaUrl: string): boolean =>
  link.server === null || sameServer(link.server, mediaUrl);
