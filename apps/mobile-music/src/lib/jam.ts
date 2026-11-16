/**
 * Jams, old music's name for group sessions, as the music app reaches them over `core.together.*`
 * (ADR 0017): their links, and the words for how one ended.
 */
import type { SessionView } from "@media/player/session-react";

const LINK = /(mt_[A-Za-z0-9]+\.[A-Za-z0-9_-]+)\/?$/u;

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * The join link in opened or pasted text: the link itself (`mt_<session>.<secret>`), the web
 * client's address for it (`<server>/music/jam#<link>`), or the app's (`music://jam/<link>`).
 * Null for anything else.
 */
export const parseJamLink = (text: string): string | null =>
  LINK.exec(decoded(text.trim()))?.[1] ?? null;

/**
 * The address a Jam's link is shared at: the music web client's on the server, so a phone without
 * the app opens it in the browser. The link travels after `#`, so no request carries it.
 */
export const jamWebUrl = (mediaUrl: string, link: string): string =>
  `${mediaUrl.replace(/\/+$/u, "")}/music/jam#${link}`;

type Ended = Extract<NonNullable<SessionView>, { readonly state: "ended" }>;

/** Why a Jam ended, in old music's words. */
export const endedLine = (reason: Ended["reason"]): string =>
  reason === "host-left" ? "The host ended it." : "The host was away for half an hour.";

/** Names as people say them: `Sam`, `Sam & Alex`, `Sam, Alex & Riley`, `Sam, Alex & 2 others`. */
export const nameList = (names: ReadonlyArray<string>): string => {
  const [first = "", second = "", third = ""] = names;

  if (names.length <= 1) return first;

  if (names.length === 2) return `${first} & ${second}`;

  if (names.length === 3) return `${first}, ${second} & ${third}`;

  const others = names.length - 2;

  return `${first}, ${second} & ${String(others)} ${others === 1 ? "other" : "others"}`;
};
