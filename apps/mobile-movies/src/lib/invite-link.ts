/**
 * Invite links (A01 Open an Invite). The account client's links are `<server>/invite#<code>`, the
 * code in the fragment so no request carries it (ADR 0020); the app's own deep link is
 * `movies://invite?server=<server>&code=<code>`. Both name the server to connect to and the invite
 * code to redeem there. Old path links, `<server>/invite/<code>`, are refused as the account client
 * refuses them. Parsed with patterns rather than `URL`, whose
 * query support React Native only partly implements.
 */
import { normalizeServerUrl } from "@media/mobile-core/server";

/** The server an invite belongs to and its code. */
export interface InviteLink {
  /**
   * The media service as the link names it, which may leave out the scheme (`cinema.home`);
   * discovery then tries `https` and `http`.
   */
  readonly server: string;
  readonly code: string;
}

const SCHEME = /^[a-z][a-z\d+.-]*:\/\//iu;

const validServer = (server: string | null): string | null =>
  server === null || normalizeServerUrl(server) === null
    ? null
    : server.trim().replace(/\/+$/u, "");

const MAX_CODE_LENGTH = 200;

const decode = (text: string): string | null => {
  try {
    return decodeURIComponent(text.replaceAll("+", " "));
  } catch {
    return null;
  }
};

const validCode = (raw: string | null | undefined): string | null => {
  const code = raw === null || raw === undefined ? null : decode(raw)?.trim();

  return code === undefined || code === null || code === "" || code.length > MAX_CODE_LENGTH
    ? null
    : code;
};

const queryValue = (query: string, name: string): string | null => {
  for (const pair of query.split("&")) {
    const [key = "", ...rest] = pair.split("=");

    if (decode(key) === name) return rest.join("=");
  }

  return null;
};

const DEEP_LINK = /^movies:\/\/\/?invite(?:\/(?<path>[^?#]*))?(?:\?(?<query>[^#]*))?(?:#.*)?$/iu;

const WEB_LINK = /^(?:(?<scheme>https?):\/\/)?(?<base>[^?#\s]+?)\/invite\/?#(?<code>[^#\s]+)$/iu;

const parseDeepLink = (text: string): InviteLink | null => {
  const groups = DEEP_LINK.exec(text)?.groups;

  if (groups === undefined) return null;
  const query = groups["query"] ?? "";
  const server = queryValue(query, "server");
  const code = validCode(queryValue(query, "code") ?? groups["path"]);
  const address = validServer(server === null ? null : decode(server));

  return code === null || address === null ? null : { server: address, code };
};

const parseWebLink = (text: string): InviteLink | null => {
  const groups = WEB_LINK.exec(text)?.groups;

  if (groups === undefined) return null;
  const scheme = groups["scheme"];
  const base = groups["base"] ?? "";
  const address = validServer(scheme === undefined ? base : `${scheme}://${base}`);
  const code = validCode(groups["code"]);

  return code === null || address === null ? null : { server: address, code };
};

/**
 * The invite in a pasted or opened link, or null when the text is not an invite link. Pasted web
 * links may leave out the scheme (`cinema.home/invite#mi_abc`), which then means `https`.
 */
export const parseInviteLink = (text: string): InviteLink | null => {
  const trimmed = text.trim();

  return /^movies:/iu.test(trimmed) ? parseDeepLink(trimmed) : parseWebLink(trimmed);
};

const withoutScheme = (url: string): string => url.replace(SCHEME, "");

/**
 * Whether two media service addresses name the same server. An address without a scheme matches
 * either scheme, as discovery tries both.
 */
export const sameServer = (left: string, right: string): boolean => {
  const a = normalizeServerUrl(left);
  const b = normalizeServerUrl(right);

  if (a === null || b === null) return false;

  return SCHEME.test(left.trim()) && SCHEME.test(right.trim())
    ? a === b
    : withoutScheme(a) === withoutScheme(b);
};
