import { basename, dirname, join } from "node:path";

import { Schema } from "effect";

import type { Restrictions } from "../../commands/access";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { member } from "../devices";
import type { Member } from "../devices";
import { share } from "../probe";
import { runServer } from "../service";
import type { CoreStack } from "../stack-env";
import { PersonId, answer, claimJob, finishJob, moviesLibrary, upsert } from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";
import type { ScannedItem } from "./scanned";

/** No restrictions, to start a kid's from. */
export const NONE: Restrictions = {
  maxMovieAge: null,
  hideUnrated: false,
  hideExplicitMusic: false,
  libraries: null,
};

const Done = answer(Schema.Null);

const Credits = answer(
  Schema.Struct({
    written: Schema.Boolean,
    people: Schema.Array(Schema.Struct({ personId: PersonId })),
  }),
);

interface Film {
  readonly name: string;
  readonly age: number | null;
  readonly genres: ReadonlyArray<string>;
  readonly year: number;
}

const FILMS: ReadonlyArray<Film> = [
  { name: "Big Buck Bunny", age: 0, genres: ["Animation", "Comedy"], year: 2008 },
  { name: "Sintel", age: 13, genres: ["Animation", "Fantasy"], year: 2010 },
  { name: "Tears of Steel", age: 17, genres: ["Science Fiction"], year: 2012 },
  { name: "Unrated Short", age: null, genres: ["Documentary"], year: 2015 },
];

const SHOWS = [
  { name: "Pioneer One", age: 7, episodes: 3 },
  { name: "Caminandes", age: 0, episodes: 2 },
] as const;

/** Two scanned libraries and the people they are shared with, as the demo library seeds them. */
export interface Shelf {
  readonly films: Id<"libraries">;
  readonly series: Id<"libraries">;
  /** Each title by name. */
  readonly titles: ReadonlyMap<string, Id<"titles">>;
  /** Each title's files by name: one for a movie, one per episode in order for a show. */
  readonly files: ReadonlyMap<string, ReadonlyArray<Id<"mediaFiles">>>;
  /** The person credited on Sintel. */
  readonly castId: Id<"people">;
  readonly collectionName: string;
  /** Made both libraries, so manages them. */
  readonly owner: Member;
  /** Sees both libraries. */
  readonly aiko: Member;
  /** Holds an edit grant on Films and sees Series. */
  readonly mateo: Member;
  /** Sees only Series. */
  readonly sam: Member;
  /** Sees both libraries, as a member an admin restricted to PG. */
  readonly kid: Member;
  /** An admin with no grant at all, who sees nothing. */
  readonly outsider: Member;
}

const at = <T>(values: ReadonlyArray<T>, index: number, what: string): T => {
  const value = values[index];

  if (value === undefined) throw new Error(`no ${what} at ${index}`);

  return value;
};

const scanInto = async (
  core: CoreStack,
  owner: Member,
  name: string,
  items: (root: string) => ReadonlyArray<ScannedItem>,
) => {
  const { libraryId, scanJobId, roots } = await moviesLibrary(owner, name);
  const lease = await claimJob(core, "movies.scan", scanJobId);
  const landed = await upsert(core, lease, items(at(roots, 0, "root")));

  if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

  return { libraryId, lease, files: landed.value.files };
};

/**
 * Scans a Films library of four rated movies and a Series library of two shows, credits Sintel's
 * cast, puts Big Buck Bunny and Sintel in a collection, and shares them as the demo grants do.
 */
export const shelfOf = async (core: CoreStack, label: string): Promise<Shelf> => {
  const owner = await member(core, `${label}-owner`, "admin");

  const films = await scanInto(core, owner, `${label} Films`, (root) =>
    FILMS.map((film) =>
      movieFile(join(root, `${film.name}.mkv`), 1, 1, {
        ...scannedTitle("movie", `nfo:${label}:${film.name}`, film.name, film.age),
        genres: [...film.genres],
        year: film.year,
      }),
    ),
  );

  const series = await scanInto(core, owner, `${label} Series`, (root) =>
    SHOWS.flatMap((show) =>
      Array.from({ length: show.episodes }, (_, n) =>
        episodeFile(
          join(root, show.name, `${n + 1}.mkv`),
          scannedTitle("show", `nfo:${label}:${show.name}`, show.name, show.age),
          1,
          n + 1,
        ),
      ),
    ),
  );

  const landed = [
    ...films.files.map((file) => ({ ...file, name: basename(file.path, ".mkv") })),
    ...series.files.map((file) => ({ ...file, name: basename(dirname(file.path)) })),
  ].toSorted((left, right) => left.path.localeCompare(right.path));

  const titles = new Map(landed.map((file) => [file.name, file.titleId]));

  const files = new Map(
    [...titles.keys()].map((name) => [
      name,
      landed.flatMap((file) => (file.name === name ? [file.fileId] : [])),
    ]),
  );

  const titleOf = (name: string): Id<"titles"> => {
    const id = titles.get(name);

    if (id === undefined) throw new Error(`no title ${name}`);

    return id;
  };

  const credited = await runServer(
    core,
    api.movies.metadata.applyCredits,
    {
      lease: films.lease,
      titleId: titleOf("Sintel"),
      episodeId: null,
      credits: [
        {
          person: {
            name: `Halina ${label}`,
            externalIds: { tmdb: `${label}-halina`, imdb: null, tvdb: null },
            profile: null,
          },
          kind: "actor",
          role: "Sintel",
          order: 0,
        },
      ],
      hash: label,
    },
    Credits,
  );

  if (credited.outcome !== "held") throw new Error(`applyCredits answered ${credited.outcome}`);

  const collectionName = `Open Movies ${label}`;

  await Promise.all(
    ["Big Buck Bunny", "Sintel"].map(async (name) =>
      runServer(
        core,
        api.movies.metadata.applyCollection,
        {
          lease: films.lease,
          titleId: titleOf(name),
          collection: {
            sourceKey: `set:${label}`,
            name: collectionName,
            overview: null,
            poster: null,
            backdrop: null,
          },
          hash: `set:${label}`,
        },
        Done,
      ),
    ),
  );

  await finishJob(core, films.lease);
  await finishJob(core, series.lease);

  const [aiko, mateo, sam, kid, outsider] = await Promise.all([
    member(core, `${label}-aiko`),
    member(core, `${label}-mateo`),
    member(core, `${label}-sam`),
    member(core, `${label}-kid`),
    member(core, `${label}-outsider`, "admin"),
  ]);

  await Promise.all([
    share(owner, films.libraryId, { kind: "user", userId: aiko.userId }, "view"),
    share(owner, films.libraryId, { kind: "user", userId: mateo.userId }, "edit"),
    share(owner, films.libraryId, { kind: "user", userId: kid.userId }, "view"),
    ...[aiko, mateo, sam, kid].map(async (who) =>
      share(owner, series.libraryId, { kind: "user", userId: who.userId }, "view"),
    ),
  ]);

  await owner.signedIn.client.mutation(api.core.restrictions.set, {
    userId: kid.userId,
    restrictions: { ...NONE, maxMovieAge: 7 },
  });

  const castId = at(credited.value.people, 0, "credited person").personId;

  return {
    films: films.libraryId,
    series: series.libraryId,
    titles,
    files,
    castId,
    collectionName,
    owner,
    aiko,
    mateo,
    sam,
    kid,
    outsider,
  };
};

/** A title of `shelf` by name. */
export const titleIn = (shelf: Shelf, name: string): Id<"titles"> => {
  const id = shelf.titles.get(name);

  if (id === undefined) throw new Error(`no title ${name}`);

  return id;
};

/** A file of a title of `shelf` by name: the first, or the one at `index`. */
export const fileIn = (shelf: Shelf, name: string, index = 0): Id<"mediaFiles"> =>
  at(shelf.files.get(name) ?? [], index, `file of ${name}`);
