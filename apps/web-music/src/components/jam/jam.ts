/**
 * Jams, music's name for group sessions, as the music client reaches them over
 * `core.together.*` (ADR 0017). A person holds one place per domain, so every call names the music
 * domain and none a session.
 */
import { MUSIC, useMusicSession } from "@media/player/session-react";
import type {
  JoinedSession,
  SessionEntry,
  SessionSettings,
  SessionView,
} from "@media/player/session-react";
import { usePlatform } from "@media/sdk/react";
import { useMemo } from "react";

/** Who may join, as the host chooses it. */
export type JoinSetting = SessionSettings["join"];

type PersonId = JoinedSession["members"][number]["userId"];

/**
 * The web address that opens a Jam's link in the music client: `/music/jam#<link>`. The link
 * travels after `#`, so no request, referrer, or server log carries it.
 */
export const jamUrl = (link: string): string =>
  `${window.location.origin}${import.meta.env.BASE_URL}jam#${link}`;

const LINK = /(mt_[A-Za-z0-9]+\.[A-Za-z0-9_-]+)\/?$/u;

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * The join link in `text`: the link itself (`mt_<session>.<secret>`), or a web address ending in
 * it, such as `/music/jam#<link>` as the Jam panel copies it. Null for anything else.
 */
export const parseJamLink = (text: string): string | null =>
  LINK.exec(decoded(text.trim()))?.[1] ?? null;

/** Why a Jam ended, for the screen. */
export const ENDED: Readonly<
  Record<Extract<NonNullable<SessionView>, { readonly state: "ended" }>["reason"], string>
> = {
  "host-left": "The host ended it.",
  abandoned: "The host was away for half an hour.",
};

/** The Jam the person is in, as the queue and the player's controls show it, or null. */
export const useJoinedJam = (): JoinedSession | null => {
  const { view } = useMusicSession();

  return view?.state === "joined" ? view : null;
};

/** What the host and every member can do about the Jam; each rejects with the core's refusal. */
export interface JamActions {
  /** Leaves the Jam, or as its host ends it for everyone; also stops waiting to join. */
  readonly leave: () => Promise<null>;
  readonly configure: (settings: SessionSettings) => Promise<null>;
  readonly admit: (userId: PersonId) => Promise<null>;
  /** Removes someone, or turns a request away; the link no longer lets them in. */
  readonly block: (userId: PersonId) => Promise<null>;
  /** Moves a queued entry to just after another, or to the front with null. */
  readonly reorder: (entryId: EntryId, afterEntryId: EntryId | null) => Promise<null>;
}

/** A queued entry of the Jam, by the id the core takes. */
export type EntryId = SessionEntry["key"];

/**
 * What shows as still to come in the Jam: its entries after `playing`, the entry the player plays,
 * which it may have moved on to by itself before the Jam did, and only those it has details for or
 * that are hidden from this person.
 */
export const upcomingInJam = (
  entries: ReadonlyArray<SessionEntry>,
  playing: string | null,
): ReadonlyArray<SessionEntry> =>
  entries.filter((entry) => entry.key !== playing && (entry.track !== null || entry.hidden));

/**
 * The entry a move to the top of what shows goes after: the last of the Jam's queue before the
 * first entry shown, as one the player moved on to by itself or one whose song still loads, or
 * null when the first entry shown leads the queue.
 */
export const frontOf = (
  entries: ReadonlyArray<SessionEntry>,
  first: EntryId | null,
): EntryId | null => {
  const at = first === null ? -1 : entries.findIndex((entry) => entry.key === first);

  return at > 0 ? (entries[at - 1]?.key ?? null) : null;
};

/** The Jam's commands, stable for as long as the platform client is. */
export const useJamActions = (): JamActions => {
  const platform = usePlatform();

  return useMemo(
    (): JamActions => ({
      leave: () => platform.core.together.leave({ domain: MUSIC }),
      configure: (settings) => platform.core.together.configure({ domain: MUSIC, ...settings }),
      admit: (userId) => platform.core.together.admit({ domain: MUSIC, userId }),
      block: (userId) => platform.core.together.block({ domain: MUSIC, userId }),
      reorder: (entryId, afterEntryId) =>
        platform.core.together.reorder(
          afterEntryId === null
            ? { domain: MUSIC, entryId }
            : { domain: MUSIC, entryId, afterEntryId },
        ),
    }),
    [platform],
  );
};
