import { Schema } from "effect";

/** Convex document IDs travel as opaque strings; the backend normalizes them per table. */
export const TrackId = Schema.NonEmptyString.pipe(Schema.brand("TrackId"));

export type TrackId = typeof TrackId.Type;

export const AlbumId = Schema.NonEmptyString.pipe(Schema.brand("AlbumId"));

export type AlbumId = typeof AlbumId.Type;

export const ArtistId = Schema.NonEmptyString.pipe(Schema.brand("ArtistId"));

export type ArtistId = typeof ArtistId.Type;

export const PlaylistId = Schema.NonEmptyString.pipe(Schema.brand("PlaylistId"));

export type PlaylistId = typeof PlaylistId.Type;

export const PlaylistItemId = Schema.NonEmptyString.pipe(Schema.brand("PlaylistItemId"));

export type PlaylistItemId = typeof PlaylistItemId.Type;

export const LibraryId = Schema.NonEmptyString.pipe(Schema.brand("LibraryId"));

export type LibraryId = typeof LibraryId.Type;

export const JobId = Schema.NonEmptyString.pipe(Schema.brand("JobId"));

export type JobId = typeof JobId.Type;

export const ApiKeyId = Schema.NonEmptyString.pipe(Schema.brand("ApiKeyId"));

export type ApiKeyId = typeof ApiKeyId.Type;

export const InviteId = Schema.NonEmptyString.pipe(Schema.brand("InviteId"));

export type InviteId = typeof InviteId.Type;

export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId"));

export type UserId = typeof UserId.Type;

/** Client-generated, stable per browser profile or CLI install. */
export const DeviceId = Schema.NonEmptyString.pipe(Schema.brand("DeviceId"));

export type DeviceId = typeof DeviceId.Type;
