import type { EpisodeId } from "@media/contracts/ids";
import type { ScannedEpisode, ScannedTitle } from "@media/contracts/models/scan";
import { METADATA_EPISODES_MAX, serverFunctions } from "@media/contracts/server-functions";
import type { Lease, MetadataTargetPage } from "@media/contracts/server-functions";
import type { CallError } from "@media/sdk/effect";
import { Effect, Option, Predicate } from "effect";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import { digestOf, toScannedCollection, toScannedCredits } from "./catalog-records.ts";
import { JobFailed } from "./core-jobs.ts";
import { lookUp, TOP_BILLED } from "../jobs/metadata-job.ts";
import { lookUpPerson, personDetailsOf } from "../jobs/person-job.ts";
import * as MetadataPlugin from "../metadata/metadata-plugin.ts";
import type * as Omdb from "../metadata/omdb.ts";
import type { TitleMetadata } from "../metadata/title-metadata.ts";
import * as CoreJobs from "./core-jobs.ts";
import type { JobStopped } from "./core-jobs.ts";
import * as CoreSession from "./core-session.ts";

const backendFailure = (error: CallError) =>
  Predicate.isTagged(error, "NotFound")
    ? new JobFailed({ message: "This title or person was removed", retry: false })
    : new JobFailed({ message: error.message, retry: true });

/** A lease-checked call's value, or why the job stops. */
const leased = <Value>(
  answer: Effect.Effect<
    | { readonly outcome: "held"; readonly value: Value }
    | { readonly outcome: "canceled" }
    | { readonly outcome: "lost" },
    CallError
  >,
): Effect.Effect<Value, JobFailed | JobStopped> =>
  answer.pipe(Effect.mapError(backendFailure), Effect.flatMap(CoreJobs.held));

type Target = Omit<MetadataTargetPage, "continueCursor" | "isDone">;

/** The title and every episode of it, one page of up to 1,000 episodes a call. */
const targetOf = (
  session: CoreSession.Interface,
  titleId: MetadataTargetPage["titleId"],
): Effect.Effect<Target, JobFailed> => {
  const from = (
    cursor: string | null,
    episodes: Target["episodes"],
  ): Effect.Effect<Target, JobFailed> =>
    session.call(serverFunctions.metadataTarget, { titleId, cursor }).pipe(
      Effect.mapError(backendFailure),
      Effect.flatMap(({ continueCursor, isDone, ...page }) => {
        const all = [...episodes, ...page.episodes];

        return isDone ? Effect.succeed({ ...page, episodes: all }) : from(continueCursor, all);
      }),
    );

  return from(null, []);
};

const STALE = "A newer match was asked for, so this job stopped";

/**
 * The metadata job on the core. It writes the title and its episodes first, so a manual match's
 * metadata lands before its credits and collection. When the core answers `applied: false`, a
 * newer match was asked for and this job stops: its writes would be dropped anyway (ADR 0012).
 */
export const handler = Effect.gen(function* () {
  const session = yield* CoreSession.Service;
  const plugin = yield* MetadataPlugin.Service;
  const keys = yield* ArtworkKeys.Service;

  const context = yield* Effect.context<
    MetadataPlugin.Service | ArtworkKeys.Service | Omdb.Service
  >();

  /** Writes the title and its episodes; false when a newer match made this job stale. */
  const applyAll = Effect.fnUntraced(function* (
    lease: Lease,
    titleId: Target["titleId"],
    title: ScannedTitle,
    episodes: ReadonlyArray<ScannedEpisode>,
    report: (done: number) => Effect.Effect<void>,
  ) {
    let rest = episodes;

    for (;;) {
      const batch = rest.slice(0, METADATA_EPISODES_MAX);

      const answer = yield* leased(
        session.call(serverFunctions.applyMetadata, { lease, titleId, title, episodes: batch }),
      );

      if (!answer.applied) return false;

      if (
        answer.done < 0 ||
        answer.done > batch.length ||
        (batch.length > 0 && answer.done === 0)
      ) {
        return yield* new JobFailed({
          message: `The core wrote ${String(answer.done)} of ${String(batch.length)} episodes`,
          retry: true,
        });
      }

      rest = rest.slice(answer.done);
      yield* report(episodes.length - rest.length);

      if (rest.length === 0) return true;
    }
  });

  return CoreJobs.handler({
    kind: "movies.metadata",
    run: Effect.fn("CoreMetadata.run")(function* (job, report) {
      const { lease, payload } = job;
      const target = yield* targetOf(session, payload.titleId);

      const found = yield* lookUp(
        target,
        Option.fromNullOr(payload.match).pipe(Option.map((match) => match.providerId)),
      ).pipe(Effect.provide(context));

      const { providerId, details, metadata, folder, title, fetched, episodes } = found;

      const applied = yield* applyAll(lease, target.titleId, title, episodes, (done) =>
        report({ done, total: episodes.length, message: "writing" }),
      );

      if (!applied) return STALE;

      const writeCredits = (episodeId: EpisodeId | null, credits: TitleMetadata["credits"]) =>
        Effect.gen(function* () {
          const scannedCredits = yield* toScannedCredits(folder, credits, keys.seal);

          const written = yield* leased(
            session.call(serverFunctions.applyCredits, {
              lease,
              titleId: target.titleId,
              episodeId,
              credits: scannedCredits,
              hash: digestOf(scannedCredits),
            }),
          );

          return written.people;
        });

      const cast = yield* writeCredits(null, metadata.credits);
      const collection = yield* toScannedCollection(folder, metadata.collection, keys.seal);

      yield* leased(
        session.call(serverFunctions.applyCollection, {
          lease,
          titleId: target.titleId,
          collection,
          hash: digestOf(collection),
        }),
      );

      yield* Effect.forEach(
        fetched,
        (episode) => writeCredits(episode.episodeId, episode.metadata.credits),
        { discard: true },
      );

      yield* Effect.forEach(
        cast
          .slice(0, TOP_BILLED)
          .flatMap((person) =>
            person.needsDetails && person.tmdbId !== null ? [{ person, tmdb: person.tmdbId }] : [],
          ),
        ({ person, tmdb }) =>
          plugin.personDetails(tmdb).pipe(
            Effect.flatMap((personFound) => personDetailsOf(personFound, keys.seal)),
            Effect.flatMap((personDetails) =>
              leased(
                session.call(serverFunctions.applyPerson, {
                  lease,
                  personId: person.personId,
                  details: personDetails,
                }),
              ),
            ),
            // A person the provider cannot give stays without details; a stopped job stops.
            Effect.catchIf(
              (error) => !Predicate.isTagged(error, "JobStopped"),
              (error) =>
                Effect.logWarning("CoreMetadata.person_failed", error.message).pipe(
                  Effect.annotateLogs({ personId: person.personId }),
                ),
            ),
          ),
        { discard: true },
      );

      return `Matched to TMDB ${providerId}: ${details.title}${details.year === undefined ? "" : ` (${String(details.year)})`}`;
    }),
  });
});

/** The person job on the core: the person's details from the metadata provider. */
export const personHandler = Effect.gen(function* () {
  const session = yield* CoreSession.Service;
  const context = yield* Effect.context<MetadataPlugin.Service | ArtworkKeys.Service>();

  return CoreJobs.handler({
    kind: "movies.person",
    run: Effect.fn("CorePerson.run")(function* (job) {
      const { lease, payload } = job;

      const target = yield* session
        .call(serverFunctions.personTarget, { personId: payload.personId })
        .pipe(Effect.mapError(backendFailure));

      const { details, summary } = yield* lookUpPerson(target).pipe(Effect.provide(context));

      yield* session
        .call(serverFunctions.applyPerson, { lease, personId: payload.personId, details })
        .pipe(Effect.mapError(backendFailure), Effect.flatMap(CoreJobs.held));

      return summary;
    }),
  });
});
