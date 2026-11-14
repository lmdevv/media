import { displayHost } from "./server";

/**
 * The account client's one-time link that signs someone up with an invite code, which a new
 * person opens in a browser or in this app (ADR 0020): `<server>/invite#<code>`.
 */
export const inviteLink = (server: string, code: string): string => `${server}/invite#${code}`;

/** The account client's one-time link that lets someone set a new password. */
export const resetLink = (server: string, code: string): string => `${server}/reset#${code}`;

/** The server's address as people read it, without the scheme: `music.example`. */
export const hostOf = (server: string): string => displayHost(server);
