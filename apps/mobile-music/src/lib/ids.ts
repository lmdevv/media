/**
 * Schemas for the core's ids, to read them from route params and stored records. They are not
 * checked beyond being text: the core checks every id it is sent, so a mistyped one fails the
 * screen's read.
 */
import { Schema } from "effect";

export { AlbumId, ArtistId, PlaylistId, TrackId } from "@/downloads/sync/models";

export const UserId = Schema.String.pipe(Schema.brand("Id<users>"));

export type UserId = typeof UserId.Type;

export const LibraryId = Schema.String.pipe(Schema.brand("Id<libraries>"));

export type LibraryId = typeof LibraryId.Type;

export const JobId = Schema.String.pipe(Schema.brand("Id<jobs>"));

export type JobId = typeof JobId.Type;

export const InviteId = Schema.String.pipe(Schema.brand("Id<invites>"));

export type InviteId = typeof InviteId.Type;

export const ApiKeyId = Schema.String.pipe(Schema.brand("Id<apiKeys>"));

export type ApiKeyId = typeof ApiKeyId.Type;
