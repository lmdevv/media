import { v } from "convex/values";

import { register } from "../../commands/movies/people";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { leaseAnswer, withJobLease } from "../core/jobs/held";
import { lease } from "../core/jobs/model";
import { enqueue } from "../core/jobs/queue";
import { fail } from "../core/lib/errors";
import { inOrder } from "../core/lib/inOrder";
import { serverMutation, serverQuery } from "../core/lib/serverFacing";
import { reachOf } from "../core/permissions/grants";
import { boundedPersonDetails } from "./bounds";
import { budgetedViewer } from "./access";
import type { BudgetedViewer, Seen } from "./access";
import { CREDIT_LIMIT, mergeIds, personKeyOf } from "./credits";
import { patchPerson } from "./write";
import { presentTitleCard } from "./present";
import { TITLE_GET, callBudget, creditRowsOf, peopleOf, settleRead } from "./reads";
import type { ReadBudget } from "./reads";
import { externalIds, scannedPersonDetails } from "./validators";

/** A person's name and external ids, for a person job to look up their details. */
export const personTarget = serverQuery({
  args: { personId: v.id("people") },
  returns: v.object({ personId: v.id("people"), name: v.string(), externalIds }),
  handler: async (ctx, { personId }) => {
    const person = (await ctx.db.get(personId)) ?? fail("not_found", "No such person");

    return { personId, name: person.name, externalIds: person.externalIds };
  },
});

/**
 * Writes a person's details during their person job, or during a metadata job of a title that
 * credits them, which fetches its top-billed people itself.
 */
export const applyPerson = serverMutation({
  args: { lease, personId: v.id("people"), details: scannedPersonDetails },
  returns: leaseAnswer(v.null()),
  handler: (ctx, { lease: held, personId, details: sent }) =>
    withJobLease(ctx, ["movies.person", "movies.metadata"], held, async (job) => {
      const details = boundedPersonDetails(sent);

      if (job.payload.kind === "movies.person" && job.payload.personId !== personId) {
        fail("invalid_args", "This job is for another person");
      }

      if (job.payload.kind === "movies.metadata") {
        const { titleId } = job.payload;

        const credited = await ctx.db
          .query("credits")
          .withIndex("by_title_episode", (q) => q.eq("titleId", titleId).eq("episodeId", null))
          .take(CREDIT_LIMIT * 2);

        if (!credited.some((row) => row.personId === personId)) {
          fail("invalid_args", "This person is not credited on the job's title");
        }
      }

      const person = (await ctx.db.get(personId)) ?? fail("not_found", "No such person");
      const ids = mergeIds(person.externalIds, details.externalIds);
      const now = Date.now();

      await patchPerson(ctx.db, person, {
        name: details.name,
        personKey: personKeyOf({ name: person.name, externalIds: ids }),
        externalIds: ids,
        profile: details.profile ?? person.profile,
        biography: details.biography,
        birthDate: details.birthDate,
        deathDate: details.deathDate,
        birthPlace: details.birthPlace,
        knownFor: details.knownFor,
        detailsFetchedAt: now,
        updatedAt: now,
      });

      return { outcome: "held", value: null };
    }),
});

const CREDIT_SCAN = 500;

const SEARCH_SCAN = 50;

const REQUEST_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const NO_PERSON = "No such person";

const KIND_RANK: Readonly<Record<Doc<"credits">["kind"], number>> = {
  actor: 0,
  "guest-star": 1,
  creator: 2,
  director: 3,
  writer: 4,
  producer: 5,
  composer: 6,
};

/** Credits one look into a person's credits reads at a time. */
const CREDIT_BATCH = 10;

const creditsAfter = (
  db: DatabaseReader,
  person: Doc<"people">,
  after: Doc<"credits"> | null,
): Promise<ReadonlyArray<Doc<"credits">>> =>
  db
    .query("credits")
    .withIndex("by_person", (q) =>
      after === null
        ? q.eq("personId", person._id)
        : q.eq("personId", person._id).gt("_creationTime", after._creationTime),
    )
    .take(CREDIT_BATCH);

/**
 * Whether the caller sees at least one title each person is credited on, reading each person's
 * credits a batch at a time only until one shows. Every read is charged to `budget`; a person the
 * budget cannot finish counts as not seen.
 */
const seenBy = async (
  db: DatabaseReader,
  seen: BudgetedViewer,
  budget: ReadBudget,
  people: ReadonlyArray<Doc<"people">>,
): Promise<ReadonlyArray<boolean>> => {
  const titles = new Map<Id<"titles">, Promise<Seen>>();

  const shows = (titleId: Id<"titles">): Promise<Seen> => {
    const known = titles.get(titleId);

    if (known !== undefined) return known;

    const decided = budget.take(TITLE_GET)
      ? db.get(titleId).then(async (title) => {
          settleRead(budget, TITLE_GET, [title]);

          return title === null ? "hidden" : seen(title);
        })
      : Promise.resolve<Seen>("spent");

    titles.set(titleId, decided);

    return decided;
  };

  const anyVisible = async (
    person: Doc<"people">,
    after: Doc<"credits"> | null,
  ): Promise<boolean> => {
    if (!budget.take(creditRowsOf(CREDIT_BATCH))) return false;

    const batch = await creditsAfter(db, person, after);
    const decided = await Promise.all(batch.map(async (credit) => shows(credit.titleId)));

    if (decided.includes("seen")) return true;

    const last = batch.at(-1);

    return batch.length < CREDIT_BATCH || decided.includes("spent") || last === undefined
      ? false
      : anyVisible(person, last);
  };

  return inOrder(people, async (person) => anyVisible(person, null));
};

interface CreditOnTitle {
  readonly title: Doc<"titles">;
  readonly kind: Doc<"credits">["kind"];
  readonly role: string | null;
  readonly episodes: number;
}

/**
 * A person's credits on titles the caller may see, from their first 500 credits. Each title is
 * read and decided once, charged to `budget`; titles the budget cannot pay for are left out.
 */
const visibleCredits = async (
  db: DatabaseReader,
  seen: BudgetedViewer,
  budget: ReadBudget,
  personId: Id<"people">,
): Promise<ReadonlyArray<CreditOnTitle>> => {
  if (!budget.take(creditRowsOf(CREDIT_SCAN))) return [];

  const rows = await db
    .query("credits")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(CREDIT_SCAN);

  const titleIds = [...new Set(rows.map((row) => row.titleId))];

  const titles = await Promise.all(
    titleIds.map(async (titleId) => {
      if (!budget.take(TITLE_GET)) return null;

      const title = await db.get(titleId);

      settleRead(budget, TITLE_GET, [title]);

      return title !== null && (await seen(title)) === "seen" ? title : null;
    }),
  );

  const visible = new Map(titles.flatMap((title) => (title === null ? [] : [[title._id, title]])));

  return [
    ...rows
      .reduce((grouped, row) => {
        const title = visible.get(row.titleId);

        if (title === undefined) return grouped;

        const key = `${row.titleId}:${row.kind}`;
        const entry = grouped.get(key);
        const episodes = row.episodeId === null ? 0 : 1;

        return grouped.set(
          key,
          entry === undefined
            ? { title, kind: row.kind, role: row.role, episodes }
            : { ...entry, role: entry.role ?? row.role, episodes: entry.episodes + episodes },
        );
      }, new Map<string, CreditOnTitle>())
      .values(),
  ];
};

const yearOf = (title: Doc<"titles">): number => title.overrides?.year ?? title.year ?? 0;

export const { get, search, requestDetails } = register({
  get: async (ctx, { personId }, caller) => {
    const person = await ctx.db.get(personId);

    if (person === null) return fail("not_found", NO_PERSON);

    const reach = await reachOf(ctx.db, caller);
    const budget = callBudget(reach);
    const seen = budgetedViewer(ctx.db, caller, reach, budget);
    const credits = await visibleCredits(ctx.db, seen, budget, personId);

    if (credits.length === 0) return fail("not_found", NO_PERSON);

    return {
      id: person._id,
      name: person.name,
      profile: person.profile,
      externalIds: person.externalIds,
      biography: person.biography,
      birthDate: person.birthDate,
      deathDate: person.deathDate,
      birthPlace: person.birthPlace,
      knownFor: person.knownFor,
      detailsPending: person.detailsFetchedAt === null && person.externalIds.tmdb !== null,
      credits: credits
        .toSorted(
          (left, right) =>
            yearOf(right.title) - yearOf(left.title) ||
            KIND_RANK[left.kind] - KIND_RANK[right.kind],
        )
        .map((entry) => ({
          title: presentTitleCard(entry.title),
          kind: entry.kind,
          role: entry.role,
          episodeCount: entry.episodes,
        })),
    };
  },
  search: async (ctx, { query: typed, limit }, caller) => {
    const text = typed.trim();

    if (text.length === 0) return [];

    const wanted =
      limit === undefined || !Number.isFinite(limit)
        ? 10
        : Math.min(Math.max(Math.floor(limit), 1), 50);

    const reach = await reachOf(ctx.db, caller);
    const budget = callBudget(reach);

    const reserved = peopleOf(SEARCH_SCAN);

    if (!budget.take(reserved)) return [];

    const matches = await ctx.db
      .query("people")
      .withSearchIndex("search_name", (q) => q.search("name", text))
      .take(SEARCH_SCAN);

    settleRead(budget, reserved, matches);

    const visible = await seenBy(
      ctx.db,
      budgetedViewer(ctx.db, caller, reach, budget),
      budget,
      matches,
    );

    return matches
      .filter((_, index) => visible[index] === true)
      .slice(0, wanted)
      .map((person) => ({
        id: person._id,
        name: person.name,
        profile: person.profile,
        knownFor: person.knownFor,
      }));
  },
  requestDetails: async (ctx, { personId }, caller) => {
    const person = await ctx.db.get(personId);

    if (person === null) return fail("not_found", NO_PERSON);

    const reach = await reachOf(ctx.db, caller);
    const budget = callBudget(reach);

    const [seen] = await seenBy(ctx.db, budgetedViewer(ctx.db, caller, reach, budget), budget, [
      person,
    ]);

    if (seen !== true) return fail("not_found", NO_PERSON);

    const now = Date.now();

    const due =
      person.detailsFetchedAt === null &&
      person.externalIds.tmdb !== null &&
      (person.detailsRequestedAt === undefined ||
        now - person.detailsRequestedAt >= REQUEST_COOLDOWN_MS);

    if (due) {
      await patchPerson(ctx.db, person, { detailsRequestedAt: now });
      await enqueue(ctx, { kind: "movies.person", personId, revision: person.updatedAt });
    }

    return null;
  },
});
