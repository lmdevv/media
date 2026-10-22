/**
 * How the playlist screens (page 15) word a playlist: its size, who can open it, and what the
 * viewer may do with it.
 */
import type { Playlist, PlaylistAccess, PlaylistRole } from "@music/commands/models";

import { countOf } from "./format";

/** Who can open a playlist besides its owner, as its owner sees it. */
export type PlaylistReach = "private" | "people" | "link";

/** A playlist's reach: by link wins, since it opens to everyone on the server. */
export const playlistReach = (
  playlist: Pick<Playlist, "visibility" | "sharedWithPeople">,
): PlaylistReach =>
  playlist.visibility === "shared" ? "link" : playlist.sharedWithPeople ? "people" : "private";

const REACH_LABELS = {
  private: "Only you",
  people: "Shared with people",
  link: "Shared by link",
} as const satisfies Record<PlaylistReach, string>;

/** The privacy line under a playlist's hero (C02): `Only you`, `Shared by link`. */
export const reachLabel = (reach: PlaylistReach): string => REACH_LABELS[reach];

/** A playlist's size, or `No songs yet` for an empty one (C06). */
const songCount = (count: number): string =>
  count === 0 ? "No songs yet" : countOf(count, "song");

const ROLE_LABELS = {
  viewer: "Viewer",
  collaborator: "Collaborator",
} as const satisfies Record<PlaylistRole, string>;

/** A role on someone else's playlist, as rows and the role sheet name it. */
export const roleName = (role: PlaylistRole): string => ROLE_LABELS[role];

/**
 * A playlist row's subtitle. Your own say who can open them (`24 songs · Only you`); shared ones
 * say whose they are and your role (`42 songs · Sam · Collaborator`).
 */
export const playlistLine = (playlist: Playlist): string => {
  const size = songCount(playlist.trackCount);

  if (playlist.access === "owner") return `${size} · ${reachLabel(playlistReach(playlist))}`;

  return [size, playlist.owner?.name, roleName(playlist.access)]
    .filter((part) => part !== undefined)
    .join(" · ");
};

/** An add-to-playlist row's subtitle (C06): the size, plus the role on someone else's. */
export const addTargetLine = (playlist: Pick<Playlist, "trackCount" | "access">): string =>
  playlist.access === "owner"
    ? songCount(playlist.trackCount)
    : `${songCount(playlist.trackCount)} · ${roleName(playlist.access)}`;

/** A total length in hours and minutes, `1 hr 46 min`, at least a minute when there is any. */
export const totalLength = (durationMs: number): string => {
  const minutes = durationMs <= 0 ? 0 : Math.max(1, Math.round(durationMs / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours === 0) return `${String(rest)} min`;

  return rest === 0 ? `${String(hours)} hr` : `${String(hours)} hr ${String(rest)} min`;
};

/** The hero's mono line (C02): `24 SONGS · 1 HR 46 MIN`, or just the size when it has none. */
export const playlistMeta = (trackCount: number, durationMs: number): string =>
  (trackCount === 0
    ? songCount(0)
    : `${countOf(trackCount, "song")} · ${totalLength(durationMs)}`
  ).toLocaleUpperCase("en-US");

/** How the actions sheet (C08) and the sharing page (C09) describe whose playlist it is. */
export const ownershipLine = (
  playlist: Pick<Playlist, "trackCount" | "access" | "owner">,
  where: "actions" | "sharing",
): string => {
  const size = songCount(playlist.trackCount);

  if (playlist.access !== "owner") return `${size} · By ${playlist.owner?.name ?? "someone else"}`;

  return `${size} · ${where === "actions" ? "Created by you" : "You own this playlist"}`;
};

/** Whose playlist a shared one is (C11): `Shared by Sam`. */
export const sharedByLine = (owner: Playlist["owner"]): string =>
  owner === null ? "Shared with you" : `Shared by ${owner.name}`;

const ACCESS_LINES = {
  owner: "You own this playlist",
  collaborator: "You’re a collaborator",
  viewer: "You can listen",
} as const satisfies Record<PlaylistAccess, string>;

/** The viewer's role on a playlist, under whose it is (C11). */
export const accessLine = (access: PlaylistAccess): string => ACCESS_LINES[access];
