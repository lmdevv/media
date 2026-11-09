import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { Schema } from "effect";

import type { DomainItem } from "../commands/access";
import type { ContentDomain } from "../commands/scopes";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { member, sharedAdmin } from "./devices";
import type { Member } from "./devices";
import { movie, seedLibrary, share, song } from "./probe";
import { importRows, newestRows } from "./rows";
import { unique } from "./sign-in";
import type { CoreStack } from "./stack-env";

/** What `core.together.get` answers. */
export type View = FunctionReturnType<typeof api.core.together.get>;

/** A joined view of a group session. */
export type Joined = Extract<NonNullable<View>, { readonly state: "joined" }>;

/** Items in two libraries a host manages, and a way to share both with someone. */
export interface Catalog {
  readonly host: Member;
  /** A movie for everyone. */
  readonly g: DomainItem;
  /** A movie for 17 and up. */
  readonly r: DomainItem;
  /** A movie for 7 and up. */
  readonly pg: DomainItem;
  readonly track: DomainItem;
  readonly share: (who: Member) => Promise<void>;
}

const title = (id: Id<"titles">): DomainItem => ({
  domain: "movies",
  ref: { type: "title", id },
});

const probeTrack = (id: Id<"probeItems">): DomainItem => ({
  domain: "music",
  ref: { type: "probeTrack", id },
});

const only = <T>(values: ReadonlyArray<T>, at: number): T => {
  const value = values[at];

  if (value === undefined) throw new Error(`seeded no item ${at}`);

  return value;
};

/** A new host who manages a movies and a music library, shared with each person on request. */
export const catalog = async (stack: CoreStack): Promise<Catalog> => {
  const host = await member(stack, "host");

  const films = await seedLibrary(stack, host, {
    name: "Films",
    kind: "movies",
    items: [movie("g", 0), movie("r", 17), movie("pg", 7)],
  });

  const songs = await seedLibrary(stack, host, {
    name: "Songs",
    kind: "music",
    items: [song("clean", false)],
  });

  const track = only(songs.itemIds, 0);

  return {
    host,
    g: title(only(films.itemIds, 0)),
    r: title(only(films.itemIds, 1)),
    pg: title(only(films.itemIds, 2)),
    track: probeTrack(track),
    share: async (who) => {
      await Promise.all(
        [films.libraryId, songs.libraryId].map(async (libraryId) =>
          share(host, libraryId, { kind: "user", userId: who.userId }, "view"),
        ),
      );
    },
  };
};

/** A new member the catalog is shared with. */
export const guestOf = async (stack: CoreStack, shelf: Catalog, label: string): Promise<Member> => {
  const guest = await member(stack, label);

  await shelf.share(guest);

  return guest;
};

/** A new member an admin restricted to movies rated 7 and under, the catalog shared with them. */
export const kidOf = async (stack: CoreStack, shelf: Catalog): Promise<Member> => {
  const kid = await guestOf(stack, shelf, "kid");
  const admin = await sharedAdmin(stack);

  await admin.signedIn.client.mutation(api.core.restrictions.set, {
    userId: kid.userId,
    restrictions: { maxMovieAge: 7, hideUnrated: true, hideExplicitMusic: true, libraries: null },
  });

  return kid;
};

/** The view `who` has of their session in `domain`, which must be joined. */
export const joinedView = async (who: Member, domain: ContentDomain): Promise<Joined> => {
  const view = await who.signedIn.client.query(api.core.together.get, { domain });

  if (view?.state !== "joined") throw new Error(`expected a joined view, got ${view?.state}`);

  return view;
};

/** A live subscription to someone's view of their session in one domain. */
export interface Watch {
  readonly latest: () => View | undefined;
  /** The first view, from now on, that `matches`; rejects after `timeoutMs`. */
  readonly until: (matches: (view: View) => boolean, timeoutMs?: number) => Promise<View>;
  readonly close: () => Promise<void>;
}

/** Subscribes to `who`'s view of their session in `domain` over a WebSocket. */
export const watch = (stack: CoreStack, who: Member, domain: ContentDomain): Watch => {
  const client = new ConvexClient(stack.url, { logger: false });
  const waiters = new Set<(view: View) => void>();
  let latest: View | undefined;

  client.setAuth(async () => who.signedIn.token);
  client.onUpdate(api.core.together.get, { domain }, (view) => {
    latest = view;

    for (const waiter of waiters) waiter(view);
  });

  return {
    latest: () => latest,
    until: (matches, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const check = (view: View): void => {
          if (!matches(view)) return;

          waiters.delete(check);
          clearTimeout(timer);
          resolve(view);
        };

        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(`no matching view within ${timeoutMs} ms; last ${JSON.stringify(latest)}`),
          );
        }, timeoutMs);

        waiters.add(check);

        if (latest !== undefined) check(latest);
      }),
    close: () => client.close(),
  };
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Runs `step`, then waits `gapMs`, again and again while `going()` holds. */
export const repeat = async (
  going: () => boolean,
  gapMs: number,
  step: () => Promise<void>,
): Promise<void> => {
  if (!going()) return;

  await step();
  await sleep(gapMs);

  return repeat(going, gapMs, step);
};

/** Waits until `holds()` or `timeoutMs` passes, checking every 5 ms; answers whether it held. */
export const waitFor = async (holds: () => boolean, timeoutMs: number): Promise<boolean> => {
  if (holds()) return true;

  if (timeoutMs <= 0) return false;

  await sleep(5);

  return waitFor(holds, timeoutMs - 5);
};

const ServiceRow = Schema.fromJsonString(
  Schema.Struct({ _id: Schema.String, name: Schema.optional(Schema.String) }),
);

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack's export wrote this one as a `users` id; the backend checks it again when a call names it.
const isUserId = (value: string): value is Id<"users"> => value.length > 0;

export const plantedStrangers = (count: number): ReadonlyArray<Id<"users">> => {
  const prefix = `stranger-${unique()}-`;

  importRows(
    "users",
    Array.from({ length: count }, (_, index) => ({
      kind: "service" as const,
      name: `${prefix}${index}`,
      sessionGeneration: 0,
      keyGeneration: 0,
    })),
  );

  const ids = newestRows("users", count + 100)
    .map((line) => Schema.decodeSync(ServiceRow)(line))
    .flatMap((row) =>
      row.name?.startsWith(prefix) === true && isUserId(row._id) ? [row._id] : [],
    );

  if (ids.length !== count) throw new Error(`planted ${ids.length} of ${count} strangers`);

  return ids;
};
