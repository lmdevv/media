import type { GenericDocument, WithoutSystemFields } from "convex/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  fitCollection,
  fitCredit,
  fitEpisode,
  fitGenreRow,
  fitMediaFile,
  fitPerson,
  fitProgress,
  fitSeason,
  fitTitle,
} from "./fit";

/**
 * The only writer of the movies tables: every insert, patch, and replace of a title, title genre,
 * season, episode, person, credit, media file, collection, collection item, progress row, list
 * entry, or watch mark goes through here (a test fails on any other). Titles, episodes, people,
 * credits, and collections are fitted within their bounds as whole documents (ADR 0024), so the
 * reads may reserve those bounds (ADR 0005); the other tables hold ids, numbers, literals, and
 * fields bounded where the server functions parse them.
 */

type Db = MutationCtx["db"];

type Fields<T extends keyof Rows> = WithoutSystemFields<Rows[T]>;

/** Fields to write over a row, as Convex patches them: an undefined optional field is removed. */
type Patch<Row extends GenericDocument> = {
  readonly [K in keyof WithoutSystemFields<Row>]?: undefined extends WithoutSystemFields<Row>[K]
    ? WithoutSystemFields<Row>[K] | undefined
    : WithoutSystemFields<Row>[K];
};

interface Rows {
  readonly titles: Doc<"titles">;
  readonly seasons: Doc<"seasons">;
  readonly mediaFiles: Doc<"mediaFiles">;
  readonly episodes: Doc<"episodes">;
  readonly people: Doc<"people">;
  readonly credits: Doc<"credits">;
  readonly collections: Doc<"collections">;
}

export const insertTitle = async (db: Db, fields: Fields<"titles">): Promise<Id<"titles">> =>
  db.insert("titles", fitTitle(fields));

/** Writes `fields` over a title, fitting the merged document; answers the title as stored. */
export const patchTitle = async (
  db: Db,
  existing: Doc<"titles">,
  fields: Partial<Fields<"titles">>,
): Promise<Doc<"titles">> => {
  const merged: Doc<"titles"> = { ...existing, ...fields };
  const fitted = fitTitle(merged);

  if (fitted === merged) await db.patch(existing._id, fields);
  else await db.replace(existing._id, fitted);

  return fitted;
};

export const insertEpisode = async (db: Db, fields: Fields<"episodes">): Promise<Id<"episodes">> =>
  db.insert("episodes", fitEpisode(fields));

/** Writes `fields` over an episode, fitting the merged document; answers it as stored. */
export const patchEpisode = async (
  db: Db,
  existing: Doc<"episodes">,
  fields: Partial<Fields<"episodes">>,
): Promise<Doc<"episodes">> => {
  const merged: Doc<"episodes"> = { ...existing, ...fields };
  const fitted = fitEpisode(merged);

  if (fitted === merged) await db.patch(existing._id, fields);
  else await db.replace(existing._id, fitted);

  return fitted;
};

export const insertPerson = async (db: Db, fields: Fields<"people">): Promise<Id<"people">> =>
  db.insert("people", fitPerson(fields));

/** Writes `fields` over a person, fitting the merged document; answers them as stored. */
export const patchPerson = async (
  db: Db,
  existing: Doc<"people">,
  fields: Partial<Fields<"people">>,
): Promise<Doc<"people">> => {
  const merged: Doc<"people"> = { ...existing, ...fields };
  const fitted = fitPerson(merged);

  if (fitted === merged) await db.patch(existing._id, fields);
  else await db.replace(existing._id, fitted);

  return fitted;
};

export const insertCredit = async (db: Db, fields: Fields<"credits">): Promise<Id<"credits">> =>
  db.insert("credits", fitCredit(fields));

export const insertCollection = async (
  db: Db,
  fields: Fields<"collections">,
): Promise<Id<"collections">> => db.insert("collections", fitCollection(fields));

/** Writes `fields` over a collection, fitting the merged document; answers it as stored. */
export const patchCollection = async (
  db: Db,
  existing: Doc<"collections">,
  fields: Partial<Fields<"collections">>,
): Promise<Doc<"collections">> => {
  const merged: Doc<"collections"> = { ...existing, ...fields };
  const fitted = fitCollection(merged);

  if (fitted === merged) await db.patch(existing._id, fields);
  else await db.replace(existing._id, fitted);

  return fitted;
};

export const insertTitleGenre = async (
  db: Db,
  fields: WithoutSystemFields<Doc<"titleGenres">>,
): Promise<Id<"titleGenres">> => db.insert("titleGenres", fitGenreRow(fields));

export const patchTitleGenre = async (
  db: Db,
  id: Id<"titleGenres">,
  fields: Partial<WithoutSystemFields<Doc<"titleGenres">>>,
): Promise<void> => db.patch(id, fitGenreRow(fields));

export const insertSeason = async (db: Db, fields: Fields<"seasons">): Promise<Id<"seasons">> =>
  db.insert("seasons", fitSeason(fields));

/** Writes `fields` over a season, fitting the merged document; answers it as stored. */
export const patchSeason = async (
  db: Db,
  existing: Doc<"seasons">,
  fields: Partial<Fields<"seasons">>,
): Promise<Doc<"seasons">> => {
  const merged: Doc<"seasons"> = { ...existing, ...fields };
  const fitted = fitSeason(merged);

  if (fitted === merged) await db.patch(existing._id, fields);
  else await db.replace(existing._id, fitted);

  return fitted;
};

export const insertMediaFile = async (
  db: Db,
  fields: Fields<"mediaFiles">,
): Promise<Id<"mediaFiles">> => db.insert("mediaFiles", fitMediaFile(fields));

/** Writes `fields` over a media file, fitting the merged document; answers it as stored. */
export const patchMediaFile = async (
  db: Db,
  existing: Doc<"mediaFiles">,
  fields: Partial<Fields<"mediaFiles">>,
): Promise<Doc<"mediaFiles">> => {
  const merged: Doc<"mediaFiles"> = { ...existing, ...fields };
  const fitted = fitMediaFile(merged);

  if (fitted === merged) await db.patch(existing._id, fields);
  else await db.replace(existing._id, fitted);

  return fitted;
};

/**
 * Writes `next` as the whole of a media file, fitted, so a field `next` leaves out is removed;
 * answers the file as stored.
 */
export const replaceMediaFile = async (
  db: Db,
  existing: Doc<"mediaFiles">,
  next: Fields<"mediaFiles">,
): Promise<Doc<"mediaFiles">> => {
  const fitted = fitMediaFile(next);

  await db.replace(existing._id, fitted);

  return { ...fitted, _id: existing._id, _creationTime: existing._creationTime };
};

export const insertCollectionItem = async (
  db: Db,
  fields: WithoutSystemFields<Doc<"collectionItems">>,
): Promise<Id<"collectionItems">> => db.insert("collectionItems", fields);

export const patchCollectionItem = async (
  db: Db,
  id: Id<"collectionItems">,
  fields: Patch<Doc<"collectionItems">>,
): Promise<void> => db.patch(id, fields);

export const insertProgress = async (
  db: Db,
  fields: WithoutSystemFields<Doc<"watchProgress">>,
): Promise<Id<"watchProgress">> => db.insert("watchProgress", fitProgress(fields));

export const patchProgress = async (
  db: Db,
  id: Id<"watchProgress">,
  fields: Patch<Doc<"watchProgress">>,
): Promise<void> => db.patch(id, fitProgress(fields));

export const insertListEntry = async (
  db: Db,
  fields: WithoutSystemFields<Doc<"myList">>,
): Promise<Id<"myList">> => db.insert("myList", fields);

export const insertWatchMark = async (
  db: Db,
  fields: WithoutSystemFields<Doc<"watchMarks">>,
): Promise<Id<"watchMarks">> => db.insert("watchMarks", fields);

export const patchWatchMark = async (
  db: Db,
  id: Id<"watchMarks">,
  fields: Patch<Doc<"watchMarks">>,
): Promise<void> => db.patch(id, fields);
