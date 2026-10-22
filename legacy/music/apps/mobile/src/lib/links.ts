/**
 * Links the server opens in a browser or the app: `<origin>/invite/<code>` and
 * `<origin>/reset/<token>`, as the web app and the CLI print them.
 */
import type { ServerOrigin } from "./server";

/** The one-time link that signs someone up with an invite code. */
export const inviteLink = (origin: ServerOrigin, code: string): string =>
  `${origin}/invite/${encodeURIComponent(code)}`;

/** The one-time link that lets someone set a new password. */
export const resetLink = (origin: ServerOrigin, token: string): string =>
  `${origin}/reset/${encodeURIComponent(token)}`;

/** The server's address as people read it, without the scheme: `music.example`. */
export const hostOf = (origin: ServerOrigin): string => new URL(origin).host;
