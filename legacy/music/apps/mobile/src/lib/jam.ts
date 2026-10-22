/**
 * What the Jam screens show, decided from `jam.get` alone: which screen the person is on, the
 * summaries the host's rows read, and the settings a save changes. Pure, so it is tested without
 * a phone.
 */
import type { UserId } from "@music/commands/ids";
import type { Jam, JamMember, JamSettings, QueueEntry } from "@music/commands/models";

import { parseEntryLink, linkIsFor } from "./entry-link";
import { countOf } from "./format";
import type { ServerOrigin } from "./server";

/**
 * Which Jam screen shows. `declined` and `removed` are what someone waiting or in the Jam sees
 * when it disappears from under them; the server keeps no record of why, so the screen remembers
 * the Jam it last saw.
 */
export type JamScreen =
  | { readonly kind: "loading" }
  | { readonly kind: "none" }
  | { readonly kind: "host"; readonly jam: Jam }
  | { readonly kind: "member"; readonly jam: Jam }
  | { readonly kind: "waiting"; readonly jam: Jam }
  | { readonly kind: "ended"; readonly jam: Jam }
  | { readonly kind: "declined"; readonly hostName: string }
  | { readonly kind: "removed"; readonly hostName: string };

/** The screen each place in an active Jam shows. */
const ROLE_SCREENS = {
  host: "host",
  member: "member",
  pending: "waiting",
} as const satisfies Record<Jam["role"], JamScreen["kind"]>;

/** The screen for an active or ended Jam, by the viewer's place in it. */
const screenOf = (jam: Jam): JamScreen =>
  jam.status === "ended" ? { kind: "ended", jam } : { kind: ROLE_SCREENS[jam.role], jam };

/**
 * The screen for `jam` (undefined while loading). `last` is the last Jam the screen saw; while the
 * person leaves on purpose (`leaving`), it keeps showing that Jam instead of saying they were
 * turned away.
 */
export const jamScreen = (
  jam: Jam | null | undefined,
  last: Jam | null,
  leaving: boolean,
): JamScreen => {
  if (jam === undefined) return { kind: "loading" };

  if (jam !== null) return screenOf(jam);

  if (last === null) return { kind: "none" };

  if (leaving) return screenOf(last);

  if (last.status === "ended" || last.role === "host") return { kind: "none" };

  return last.role === "pending"
    ? { kind: "declined", hostName: last.host.name }
    : { kind: "removed", hostName: last.host.name };
};

/** The link people open to join: `<origin>/jam/<code>`. */
export const jamLink = (origin: ServerOrigin, code: string): string =>
  `${origin}/jam/${encodeURIComponent(code)}`;

/** Names as people say them: `Sam`, `Sam & Alex`, `Sam, Alex & Riley`, `Sam, Alex & 2 others`. */
export const nameList = (names: ReadonlyArray<string>): string => {
  const [first = "", second = "", third = ""] = names;

  switch (names.length) {
    case 0:
      return "";
    case 1:
      return first;
    case 2:
      return `${first} & ${second}`;
    case 3:
      return `${first}, ${second} & ${third}`;
    default:
      return `${first}, ${second} & ${countOf(names.length - 2, "other")}`;
  }
};

/** A row's two lines. */
export interface RowText {
  readonly title: string;
  readonly subtitle: string;
}

const joinedOf = (members: ReadonlyArray<JamMember>): ReadonlyArray<JamMember> =>
  members.filter((member) => member.status === "joined");

const waitingOf = (members: ReadonlyArray<JamMember>): ReadonlyArray<JamMember> =>
  members.filter((member) => member.status === "pending");

/** The host's row for everyone in the Jam (D02): who, and how many listen along. */
export const peopleRow = (members: ReadonlyArray<JamMember>): RowText => {
  const joined = joinedOf(members);

  if (joined.length === 0) {
    return { title: "No one yet", subtitle: "Share the link to invite people" };
  }

  const listening = joined.filter((member) => member.listening).length;
  const people = countOf(joined.length, "person", "people");

  const how =
    listening === joined.length
      ? "Listening along"
      : listening === 0
        ? "In the Jam"
        : `${String(listening)} listening along`;

  return {
    title: nameList(joined.map((member) => member.person.name)),
    subtitle: `${how} · ${people}`,
  };
};

/** The host's highlighted row for people waiting to be let in (D02), or null when nobody is. */
export const requestsRow = (members: ReadonlyArray<JamMember>): RowText | null => {
  const waiting = waitingOf(members);

  if (waiting.length === 0) return null;

  return {
    title: `${countOf(waiting.length, "request")} to join`,
    subtitle: `${nameList(waiting.map((member) => member.person.name))} ${waiting.length === 1 ? "is" : "are"} waiting`,
  };
};

/** People in the Jam and people waiting, in the server's order. */
export const jamPeople = (members: ReadonlyArray<JamMember>) => ({
  joined: joinedOf(members),
  waiting: waitingOf(members),
});

/** What a member is doing, as D03 words it. */
export const memberStatus = (member: JamMember, settings: JamSettings): string => {
  if (member.listening) return "Listening along";

  return settings.membersCanAdd || settings.membersCanControl
    ? "Controlling the queue"
    : "In the Jam";
};

/** How many listen in the host's Jam, the host included (D08's "4 people listening"). */
export const listenerCount = (jam: Jam): string =>
  `${countOf(1 + joinedOf(jam.members).filter((member) => member.listening).length, "person", "people")} listening`;

/** The host's settings as the form edits them, before they are saved. */
export type SettingsDraft = { readonly [K in keyof JamSettings]: JamSettings[K] };

/** What `jam.settings` takes: only the settings that change, with 0 for no limit. */
export type SettingsChange = {
  -readonly [K in keyof JamSettings]?: K extends "addLimit" ? number : JamSettings[K];
};

/** Changes from `saved` to `draft`, as `jam.settings` takes them; empty when nothing changed. */
export const settingsChanges = (saved: SettingsDraft, draft: SettingsDraft): SettingsChange => {
  const changes: SettingsChange = {};

  if (draft.join !== saved.join) changes.join = draft.join;

  if (draft.membersCanAdd !== saved.membersCanAdd) changes.membersCanAdd = draft.membersCanAdd;

  if (draft.addLimit !== saved.addLimit) changes.addLimit = draft.addLimit ?? 0;

  if (draft.membersCanControl !== saved.membersCanControl) {
    changes.membersCanControl = draft.membersCanControl;
  }

  if (draft.membersCanEdit !== saved.membersCanEdit) changes.membersCanEdit = draft.membersCanEdit;

  if (draft.listenAlong !== saved.listenAlong) changes.listenAlong = draft.listenAlong;

  return changes;
};

/** Limits the host can pick for songs per person; null is no limit. */
export const ADD_LIMITS: ReadonlyArray<number | null> = [null, 1, 3, 5, 10, 20, 50];

/** D04's subtitle for the songs-per-person row. */
export const addLimitLine = (limit: number | null): string =>
  limit === null
    ? "No limit · each person adds as many as they like"
    : `${countOf(limit, "song")} each`;

/** The queue fields that say who added an entry. */
type Added = Pick<QueueEntry, "autoplay" | "addedBy">;

/** The member's own songs still to play, in queue order. */
export const contributionsOf = <Entry extends Added>(
  queue: ReadonlyArray<Entry>,
  index: number,
  me: UserId,
): ReadonlyArray<Entry> =>
  queue.slice(index + 1).filter((entry) => !entry.autoplay && entry.addedBy?.id === me);

/** D08's quota notice: how many songs the member has coming up, and what they may change. */
export const quotaNotice = (count: number, jam: Jam): RowText => {
  const { addLimit, membersCanEdit } = jam.settings;
  const host = jam.host.name;

  const title =
    addLimit === null
      ? `${countOf(count, "song")} added`
      : `${String(count)} of ${countOf(addLimit, "song")} added`;

  const subtitle = {
    none: `${host} controls the queue.`,
    own: `You can edit your own additions. ${host} controls the rest.`,
    any: "You can move and remove any song in the queue.",
  }[membersCanEdit];

  return { title, subtitle };
};

const ENDED_LINES = {
  host: (host: string) => `${host} ended the Jam.`,
  host_offline: (host: string) => `${host} went offline for a while.`,
  idle: () => "Nothing played for a while.",
} as const satisfies Record<NonNullable<Jam["endedReason"]>, (host: string) => string>;

/** Why D11 says the Jam ended. */
export const endedLine = (jam: Jam): string =>
  ENDED_LINES[jam.endedReason ?? "host"](jam.host.name);

/** A Jam code typed or pasted into D12, or why it can't be used. */
export type JamCodeInput =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: string };

const BARE_CODE = /^[\w-]{1,200}$/u;

/**
 * The Jam code in what someone typed, scanned, or pasted: a bare code, the web link, or the app's
 * own link, for the server the app is on.
 */
export const jamCodeFrom = (text: string, origin: ServerOrigin): JamCodeInput => {
  const trimmed = text.trim();

  if (BARE_CODE.test(trimmed)) return { ok: true, code: trimmed };

  const link = parseEntryLink(trimmed);

  if (link?.kind !== "jam") {
    return { ok: false, reason: "That isn’t a Jam link or code. Check it and try again." };
  }

  if (!linkIsFor(link, origin)) {
    return { ok: false, reason: "That Jam is on another server." };
  }

  return { ok: true, code: link.secret };
};

/**
 * A made-up sign-in address for a guest account, from the name they chose and a random suffix, as
 * the web makes it: `riley-k3j9x@jam.local`.
 */
export const guestEmail = (name: string, suffix: string): string => {
  const handle = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");

  return `${handle.length === 0 ? "guest" : handle}-${suffix}@jam.local`;
};
