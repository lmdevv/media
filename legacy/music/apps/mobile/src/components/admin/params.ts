/**
 * The `[id]` segment of an administration route, parsed into its ID type at the route boundary.
 * Null when the segment is missing, so a screen shows its "not found" state instead of asking the
 * server about nothing.
 */
import { InviteId, JobId, LibraryId, UserId } from "@music/commands/ids";
import { Option, Schema } from "effect";
import { useLocalSearchParams } from "expo-router";

import { useHeldSecret } from "@/components/settings/secret-slot";

const decodePerson = Schema.decodeUnknownOption(UserId);

const decodeInvite = Schema.decodeUnknownOption(InviteId);

const decodeLibrary = Schema.decodeUnknownOption(LibraryId);

const decodeJob = Schema.decodeUnknownOption(JobId);

/** The person a `people/[id]` route is about. */
export const usePersonParam = (): UserId | null =>
  Option.getOrNull(decodePerson(useLocalSearchParams().id));

/** The invite an `invites/[id]` route is about. */
export const useInviteParam = (): InviteId | null =>
  Option.getOrNull(decodeInvite(useLocalSearchParams().id));

/** The library a `libraries/[id]` route is about. */
export const useLibraryParam = (): LibraryId | null =>
  Option.getOrNull(decodeLibrary(useLocalSearchParams().id));

/** The job a `jobs/[id]` route is about. */
export const useJobParam = (): JobId | null =>
  Option.getOrNull(decodeJob(useLocalSearchParams().id));

const decodeExpiry = Schema.decodeUnknownOption(Schema.FiniteFromString);

/**
 * The one-time reset link F12 made for F23: its token from the secret slot, shown once, and when
 * it expires from the route. Null when either is missing, such as when the page is opened again.
 */
export const useResetLink = (): { readonly token: string; readonly expiresAt: number } | null => {
  const token = useHeldSecret();
  const expiresAt = Option.getOrNull(decodeExpiry(useLocalSearchParams().expiresAt));

  return token === null || expiresAt === null ? null : { token, expiresAt };
};
