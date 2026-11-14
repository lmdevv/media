import { Schema } from "effect";

/** Annotation key naming the Convex table an ID schema points into. */
export const CONVEX_TABLE_ANNOTATION = "convexTable";

/** An account. Each person in the household signs in with their own. */
export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "users",
});

/** An account, as a branded Convex document ID. */
export type UserId = typeof UserId.Type;

/** A viewing profile that belongs to one account. */
export const ProfileId = Schema.NonEmptyString.pipe(Schema.brand("ProfileId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "profiles",
});

/** A viewing profile ID. */
export type ProfileId = typeof ProfileId.Type;

/** A library: a named set of folders scanned as movies, shows, or both. */
export const LibraryId = Schema.NonEmptyString.pipe(Schema.brand("LibraryId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "libraries",
});

/** A library ID. */
export type LibraryId = typeof LibraryId.Type;

/** A movie or a show. */
export const TitleId = Schema.NonEmptyString.pipe(Schema.brand("TitleId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "titles",
});

/** A movie or show ID. */
export type TitleId = typeof TitleId.Type;

/** A season of a show. */
export const SeasonId = Schema.NonEmptyString.pipe(Schema.brand("SeasonId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "seasons",
});

/** A season ID. */
export type SeasonId = typeof SeasonId.Type;

/** An episode of a show. */
export const EpisodeId = Schema.NonEmptyString.pipe(Schema.brand("EpisodeId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "episodes",
});

/** An episode ID. */
export type EpisodeId = typeof EpisodeId.Type;

/** One media file on disk. A movie may have several versions. */
export const MediaFileId = Schema.NonEmptyString.pipe(Schema.brand("MediaFileId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "mediaFiles",
});

/** A media file ID. */
export type MediaFileId = typeof MediaFileId.Type;

/** One song's audio file in a music library. */
export const TrackId = Schema.NonEmptyString.pipe(Schema.brand("TrackId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "tracks",
});

/** A track ID. */
export type TrackId = typeof TrackId.Type;

/** A background job the media service runs: scan, metadata refresh, backup, or migration. */
export const JobId = Schema.NonEmptyString.pipe(Schema.brand("JobId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "jobs",
});

/** A job ID. */
export type JobId = typeof JobId.Type;

/** One device's logical playback of one file. Playback tokens name it in `sid`. */
export const PlaybackSessionId = Schema.NonEmptyString.pipe(
  Schema.brand("PlaybackSessionId"),
).annotate({
  [CONVEX_TABLE_ANNOTATION]: "playbackSessions",
});

/** A playback session ID. */
export type PlaybackSessionId = typeof PlaybackSessionId.Type;

/** A watch room: a shared timeline that members follow. */
export const RoomId = Schema.NonEmptyString.pipe(Schema.brand("RoomId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "rooms",
});

/** A watch room ID. */
export type RoomId = typeof RoomId.Type;

/** An API key. The secret itself is never stored. */
export const ApiKeyId = Schema.NonEmptyString.pipe(Schema.brand("ApiKeyId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "apiKeys",
});

/** An API key ID. */
export type ApiKeyId = typeof ApiKeyId.Type;

/** An invite to create an account. */
export const InviteId = Schema.NonEmptyString.pipe(Schema.brand("InviteId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "invites",
});

/** An invite ID. */
export type InviteId = typeof InviteId.Type;

/** A Convex Auth session: one signed-in browser, CLI, device, or API key. */
export const AuthSessionId = Schema.NonEmptyString.pipe(Schema.brand("AuthSessionId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "authSessions",
});

/** A sign-in session ID. */
export type AuthSessionId = typeof AuthSessionId.Type;

/** A backup archive recorded by the media service. */
export const BackupId = Schema.NonEmptyString.pipe(Schema.brand("BackupId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "backups",
});

/** A backup ID. */
export type BackupId = typeof BackupId.Type;

/** A collection of titles, such as one imported from Jellyfin or Plex. */
export const CollectionId = Schema.NonEmptyString.pipe(Schema.brand("CollectionId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "collections",
});

/** A collection ID. */
export type CollectionId = typeof CollectionId.Type;

/** A person credited on titles: an actor, director, writer, or other cast and crew. */
export const PersonId = Schema.NonEmptyString.pipe(Schema.brand("PersonId")).annotate({
  [CONVEX_TABLE_ANNOTATION]: "people",
});

/** A person ID. */
export type PersonId = typeof PersonId.Type;

/**
 * A client-generated identifier, stable per browser profile, CLI install, or TV app. It separates
 * concurrent devices on one profile; it is not a Convex document ID.
 */
export const DeviceId = Schema.NonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("DeviceId"),
);

/** A client device ID. */
export type DeviceId = typeof DeviceId.Type;
