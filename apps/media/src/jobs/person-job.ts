import type { ScannedPersonDetails } from "@media/contracts/models/scan";
import { Effect, Match, Option } from "effect";

import type { ArtworkKey } from "@media/contracts/artwork";
import { ArtworkSource } from "../artwork/artwork-keys.ts";
import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import { idsOrNull } from "../convex/catalog-records.ts";
import * as MediaBackend from "../convex/media-backend.ts";
import * as MetadataPlugin from "../metadata/metadata-plugin.ts";
import type { ProviderPerson } from "../metadata/metadata-plugin.ts";
import { JobFailed, type JobHandler } from "./job-worker.ts";

const providerFailure = Match.type<MetadataPlugin.MetadataError>().pipe(
  Match.tagsExhaustive({
    MetadataProviderUnavailable: (error) => new JobFailed({ message: error.message, retry: false }),
    MetadataRequestFailed: (error) => new JobFailed({ message: error.message, retry: true }),
    PluginPermissionDenied: (error) => new JobFailed({ message: error.message, retry: false }),
  }),
);

const isFinal = Match.type<MetadataPlugin.MetadataError>().pipe(
  Match.tagsExhaustive({
    MetadataProviderUnavailable: () => true,
    MetadataRequestFailed: (error) => error.status === 404,
    PluginPermissionDenied: () => false,
  }),
);

const backendFailure = (error: { readonly message: string }) =>
  new JobFailed({ message: error.message, retry: true });

/** The catalog record of a provider's person, with their photo sealed as an artwork key. */
export const personDetailsOf = Effect.fnUntraced(function* (
  person: ProviderPerson,
  seal: (source: ArtworkSource) => Effect.Effect<ArtworkKey>,
) {
  return {
    name: person.name,
    externalIds: idsOrNull(person.ids),
    profile:
      person.profile === undefined
        ? null
        : yield* seal(ArtworkSource.Remote({ url: person.profile })),
    biography: person.biography ?? null,
    birthDate: person.birthDate ?? null,
    deathDate: person.deathDate ?? null,
    birthPlace: person.birthPlace ?? null,
    knownFor: person.knownFor ?? null,
  } satisfies ScannedPersonDetails;
});

/**
 * Looks a person up at the metadata provider by their TMDB id. A person the provider no longer
 * knows keeps their name and ids with no details. Fails with `JobFailed` when they have no id.
 */
export const lookUpPerson = Effect.fn("PersonJob.lookUp")(function* (
  target: Pick<ScannedPersonDetails, "name" | "externalIds">,
) {
  const plugin = yield* MetadataPlugin.Service;
  const keys = yield* ArtworkKeys.Service;

  if (target.externalIds.tmdb === null) {
    return yield* new JobFailed({
      message: `${target.name} has no TMDB ID to look up`,
      retry: false,
    });
  }

  const found = yield* plugin.personDetails(target.externalIds.tmdb).pipe(
    Effect.asSome,
    Effect.catchIf(isFinal, () => Effect.succeedNone),
    Effect.mapError(providerFailure),
  );

  const details: ScannedPersonDetails = Option.isSome(found)
    ? yield* personDetailsOf(found.value, keys.seal)
    : {
        name: target.name,
        externalIds: target.externalIds,
        profile: null,
        biography: null,
        birthDate: null,
        deathDate: null,
        birthPlace: null,
        knownFor: null,
      };

  return {
    details,
    summary: Option.isSome(found)
      ? `Fetched details of ${found.value.name}`
      : `No details for ${target.name} at the metadata provider`,
  };
});

/** The person job handler. */
export const handler: Effect.Effect<
  JobHandler,
  never,
  MediaBackend.Service | MetadataPlugin.Service | ArtworkKeys.Service
> = Effect.gen(function* () {
  const backend = yield* MediaBackend.Service;
  const plugin = yield* MetadataPlugin.Service;
  const keys = yield* ArtworkKeys.Service;

  return {
    kind: "person",
    run: Effect.fn("PersonJob.run")(function* (claim, workerId) {
      const { payload } = claim.job;

      if (payload.kind !== "person") {
        return yield* new JobFailed({ message: "This is not a person job", retry: false });
      }

      const target = yield* backend
        .call("mediaService.personTarget", { personId: payload.personId })
        .pipe(Effect.mapError(backendFailure));

      const { details, summary } = yield* lookUpPerson(target).pipe(
        Effect.provideService(MetadataPlugin.Service, plugin),
        Effect.provideService(ArtworkKeys.Service, keys),
      );

      yield* backend
        .call("mediaService.applyPerson", {
          jobId: claim.job.id,
          workerId,
          personId: payload.personId,
          details,
        })
        .pipe(Effect.mapError(backendFailure));

      return summary;
    }),
  } satisfies JobHandler;
});
