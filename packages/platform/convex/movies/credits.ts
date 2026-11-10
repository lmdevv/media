import type { Infer } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { inOrder } from "../core/lib/inOrder";
import { boundedKey } from "./bounds";
import { fitPerson } from "./fit";
import { insertCredit, insertPerson, patchPerson } from "./write";
import type { externalIds, scannedCredit, scannedPerson } from "./validators";

type Db = MutationCtx["db"];

type ExternalIds = Infer<typeof externalIds>;

const NAMESAKES = 10;

/** Most credits a title or an episode keeps, and one call writes. */
export const CREDIT_LIMIT = 100;

const normalizeName = (name: string): string =>
  name
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/\s+/gu, " ")
    .trim();

/** The key that identifies a person across titles. */
export const personKeyOf = (person: {
  readonly name: string;
  readonly externalIds: ExternalIds;
}): string => {
  if (person.externalIds.tmdb !== null) return boundedKey(`tmdb:${person.externalIds.tmdb}`);

  return boundedKey(
    person.externalIds.imdb === null
      ? `name:${normalizeName(person.name)}`
      : `imdb:${person.externalIds.imdb}`,
  );
};

const sortKeyOf = (name: string): string => {
  const parts = normalizeName(name).split(" ");
  const last = parts.at(-1) ?? "";

  return [last, ...parts.slice(0, -1)].join(" ");
};

const providers = ["tmdb", "imdb", "tvdb"] as const;

/** Each provider's id from `current`, or from `found` where `current` has none. */
export const mergeIds = (current: ExternalIds, found: ExternalIds): ExternalIds => ({
  tmdb: current.tmdb ?? found.tmdb,
  imdb: current.imdb ?? found.imdb,
  tvdb: current.tvdb ?? found.tvdb,
});

const compatible = (left: ExternalIds, right: ExternalIds): boolean =>
  providers.every(
    (provider) =>
      left[provider] === null || right[provider] === null || left[provider] === right[provider],
  );

const upsertPerson = async (
  db: Db,
  person: Infer<typeof scannedPerson>,
): Promise<Doc<"people">> => {
  const name = person.name.trim();
  const key = personKeyOf({ name, externalIds: person.externalIds });

  const byKey = await db
    .query("people")
    .withIndex("by_key", (q) => q.eq("personKey", key))
    .first();

  const existing =
    byKey ??
    (
      await db
        .query("people")
        .withIndex("by_name", (q) => q.eq("name", name))
        .take(NAMESAKES)
    ).find((candidate) => compatible(candidate.externalIds, person.externalIds)) ??
    null;

  const now = Date.now();

  if (existing === null) {
    const fields = fitPerson({
      personKey: key,
      name,
      sortKey: sortKeyOf(name),
      externalIds: person.externalIds,
      profile: person.profile,
      biography: null,
      birthDate: null,
      deathDate: null,
      birthPlace: null,
      knownFor: null,
      detailsFetchedAt: null,
      updatedAt: now,
    });

    const personId = await insertPerson(db, fields);

    return { ...fields, _id: personId, _creationTime: now };
  }

  const ids = mergeIds(existing.externalIds, person.externalIds);
  const profile = existing.profile ?? person.profile;
  const personKey = personKeyOf({ name: existing.name, externalIds: ids });

  const changed =
    personKey !== existing.personKey ||
    profile !== existing.profile ||
    providers.some((provider) => ids[provider] !== existing.externalIds[provider]);

  if (!changed) return existing;

  const patch = { personKey, externalIds: ids, profile, updatedAt: now };

  return patchPerson(db, existing, patch);
};

/** The stored credits of a title (`episodeId` null) or one episode, in billing order. */
export const creditsOf = (
  db: DatabaseReader,
  titleId: Id<"titles">,
  episodeId: Id<"episodes"> | null,
  limit: number,
): Promise<Array<Doc<"credits">>> =>
  db
    .query("credits")
    .withIndex("by_title_episode", (q) => q.eq("titleId", titleId).eq("episodeId", episodeId))
    .take(limit);

/** Replaces the credits of a title or an episode and answers each credited person. */
export const replaceCredits = async (
  db: Db,
  titleId: Id<"titles">,
  episodeId: Id<"episodes"> | null,
  credits: ReadonlyArray<Infer<typeof scannedCredit>>,
): Promise<ReadonlyArray<Doc<"people">>> => {
  const previous = await creditsOf(db, titleId, episodeId, CREDIT_LIMIT * 2);

  await Promise.all(previous.map((row) => db.delete(row._id)));

  return inOrder(credits.slice(0, CREDIT_LIMIT), async (entry) => {
    const person = await upsertPerson(db, entry.person);

    await insertCredit(db, {
      titleId,
      episodeId,
      personId: person._id,
      kind: entry.kind,
      role: entry.role,
      order: entry.order,
    });

    return person;
  });
};
