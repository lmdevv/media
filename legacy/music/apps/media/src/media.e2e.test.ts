/**
 * End-to-end test against a real Convex deployment. Runs only when `MEDIA_E2E_CONVEX_URL`,
 * `MEDIA_E2E_SERVICE_SECRET`, and `MEDIA_E2E_SIGNING_KEY` are set, for example from the values in
 * `apps/media/.env.local` written by `scripts/dev-backend.sh`. It signs in as
 * `MEDIA_E2E_EMAIL` / `MEDIA_E2E_PASSWORD` (signing up when the account does not exist, which
 * makes it the admin on a fresh deployment), adds the fixture library, lets the real job worker
 * scan it, and plays every album's art and first track in every profile through signed URLs.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { FINISHED_PARAM } from "@music/commands/models";
import { makeMusicClient } from "@music/sdk/client";
import { describe, expect, it } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { ConfigProvider, Effect, Layer, Schedule } from "effect";

import * as Files from "./files.ts";
import { makeHttpApp } from "./http-app.ts";
import * as JobWorker from "./job-worker.ts";
import * as MediaBackend from "./media-backend.ts";
import * as MediaConfig from "./media-config.ts";
import { fixtureLibraryWith, probe, temporaryDirectory } from "./testing/fixtures.ts";
import * as Transcoder from "./transcoder.ts";
import { runScoped } from "./testing/run.ts";

const convexUrl = process.env.MEDIA_E2E_CONVEX_URL;

const serviceSecret = process.env.MEDIA_E2E_SERVICE_SECRET;

const signingKey = process.env.MEDIA_E2E_SIGNING_KEY;

const email = process.env.MEDIA_E2E_EMAIL ?? "e2e-admin@music.test";

const password = process.env.MEDIA_E2E_PASSWORD ?? "e2e-password-123";

const signIn = makeFunctionReference<
  "action",
  { provider: string; params: { email: string; password: string; flow: string; name: string } },
  { tokens: { token: string } | null }
>("auth:signIn");

const signedInClient = Effect.fn("E2E.signIn")(function* (url: string) {
  const http = new ConvexHttpClient(url);

  const attempt = (flow: "signIn" | "signUp") =>
    Effect.tryPromise(() =>
      http.action(signIn, {
        provider: "password",
        params: { email, password, flow, name: "E2E Admin" },
      }),
    );

  const result = yield* attempt("signIn").pipe(
    Effect.catch(() => attempt("signUp")),
    Effect.orDie,
  );

  if (result.tokens === null) return yield* Effect.die("Sign-in returned no token");
  http.setAuth(result.tokens.token);

  return makeMusicClient(http);
});

const PROFILES = ["original", "aac-320", "aac-128", "fmp4-flac", "fmp4-aac"] as const;

/** The codec each transcoding profile delivers. */
const PROFILE_CODECS = {
  "aac-320": "aac",
  "aac-128": "aac",
  "fmp4-flac": "flac",
  "fmp4-aac": "aac",
} as const;

const call = <A>(run: () => Promise<A>): Effect.Effect<A> => Effect.promise(run);

describe.skipIf(convexUrl === undefined || serviceSecret === undefined || signingKey === undefined)(
  "media service against Convex",
  { timeout: 120_000 },
  () => {
    it("scans a library through the job queue and serves its signed streams and art", () =>
      runScoped(
        Effect.gen(function* () {
          const suffix = ` (e2e ${randomUUID().slice(0, 8)})`;
          const { root, albums } = yield* fixtureLibraryWith(suffix);
          const dataDir = yield* temporaryDirectory("data");
          const client = yield* signedInClient(convexUrl ?? "");

          const config = MediaConfig.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  CONVEX_URL: convexUrl,
                  MEDIA_SERVICE_SECRET: serviceSecret,
                  STREAM_SIGNING_KEY: signingKey,
                  MEDIA_DATA_DIR: dataDir,
                }),
              ),
            ),
          );

          const services = Layer.mergeAll(MediaBackend.layer, Transcoder.layer).pipe(
            Layer.provideMerge(config),
          );

          const context = yield* Layer.build(
            Layer.merge(services, JobWorker.layer.pipe(Layer.provide(services))),
          );

          const app = yield* makeHttpApp.pipe(Effect.provideContext(context));

          const created = yield* call(() =>
            client.run("libraries.create", { name: `E2E${suffix}`, path: root }),
          );

          yield* Effect.addFinalizer(() =>
            call(() => client.run("libraries.delete", { libraryId: created.libraryId })).pipe(
              Effect.ignore,
            ),
          );

          const job = yield* call(() => client.read("jobs.get", { jobId: created.jobId })).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("200 millis"),
              until: (current) => current.status !== "pending" && current.status !== "running",
              times: 150,
            }),
          );

          expect(job).toMatchObject({
            status: "done",
            message: "10 files, 10 updated, 0 missing",
          });

          const libraries = yield* call(() => client.read("libraries.list", {}));
          const library = libraries.find((candidate) => candidate.id === created.libraryId);

          expect(library).toMatchObject({ trackCount: 10, scanning: false });

          const page = yield* call(() => client.read("albums.list", { limit: 200 }));
          const ours = page.items.filter((album) => album.title.endsWith(suffix));

          expect(ours.map((album) => album.title).toSorted()).toEqual(
            albums.map((album) => album.title).toSorted(),
          );

          for (const album of ours) {
            expect(album.artUrl).not.toBeNull();
            const artUrl = new URL(album.artUrl ?? "");
            const art = yield* call(async () => app.request(artUrl.pathname + artUrl.search));

            expect(art.status).toBe(200);
            expect(art.headers.get("Content-Type")).toMatch(/^image\//);

            const detail = yield* call(() => client.read("albums.get", { albumId: album.id }));
            const [first] = detail.tracks;

            if (first === undefined) expect.unreachable(`${album.title} has no tracks`);

            // A download of the track: 503 while its file is prepared, then the finished MP4.
            const signed = yield* call(() =>
              client.read("stream.url", { trackId: first.id, profile: "aac-320" }),
            );

            const downloadUrl = new URL(signed.url);

            downloadUrl.searchParams.set(FINISHED_PARAM, "1");

            const download = call(async () =>
              app.request(downloadUrl.pathname + downloadUrl.search),
            );

            expect((yield* download).status).toBe(503);

            const downloaded = yield* download.pipe(
              Effect.repeat({
                schedule: Schedule.spaced("100 millis"),
                until: (response) => response.status !== 503,
                times: 300,
              }),
            );

            expect(downloaded.status).toBe(200);
            const file = yield* call(async () => new Uint8Array(await downloaded.arrayBuffer()));

            expect(downloaded.headers.get("Content-Length")).toBe(String(file.length));
            expect(downloaded.headers.get("ETag")).not.toBeNull();
            expect(String.fromCodePoint(...file.subarray(4, 8))).toBe("ftyp");

            for (const profile of PROFILES) {
              const stream = yield* call(() =>
                client.read("stream.url", { trackId: first.id, profile }),
              );

              const url = new URL(stream.url);
              const response = yield* call(async () => app.request(url.pathname + url.search));

              expect(response.status).toBe(200);
              const output = join(dataDir, `${first.id}-${profile}`);
              const bytes = yield* call(async () => new Uint8Array(await response.arrayBuffer()));

              yield* Files.writeFileAtomic(output, bytes, "probe");
              const probed = yield* probe(output);

              expect(
                probed.streams.some((probedStream) => probedStream.codec_type === "audio"),
              ).toBe(true);

              if (profile !== "original") {
                expect(probed.streams[0]?.codec_name).toBe(PROFILE_CODECS[profile]);
              }

              if (profile === "fmp4-flac" || profile === "fmp4-aac") {
                expect(Number(response.headers.get("X-Music-Duration-Samples"))).toBeGreaterThan(0);
                expect(response.headers.get("X-Music-Priming-Samples")).toBe(
                  profile === "fmp4-flac" ? "0" : "1024",
                );
              }
            }
          }
        }),
      ));

    it("indexes nothing for a library whose folder is another library's under a second name", () =>
      runScoped(
        Effect.gen(function* () {
          const suffix = ` (alias ${randomUUID().slice(0, 8)})`;
          const { root } = yield* fixtureLibraryWith(suffix);
          const dataDir = yield* temporaryDirectory("data");
          const links = yield* temporaryDirectory("links");
          const client = yield* signedInClient(convexUrl ?? "");

          const config = MediaConfig.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  CONVEX_URL: convexUrl,
                  MEDIA_SERVICE_SECRET: serviceSecret,
                  STREAM_SIGNING_KEY: signingKey,
                  MEDIA_DATA_DIR: dataDir,
                }),
              ),
            ),
          );

          const services = Layer.mergeAll(MediaBackend.layer, Transcoder.layer).pipe(
            Layer.provideMerge(config),
          );

          yield* Layer.build(Layer.merge(services, JobWorker.layer.pipe(Layer.provide(services))));

          const scan = (name: string, path: string) =>
            Effect.gen(function* () {
              const created = yield* call(() => client.run("libraries.create", { name, path }));

              yield* Effect.addFinalizer(() =>
                call(() => client.run("libraries.delete", { libraryId: created.libraryId })).pipe(
                  Effect.ignore,
                ),
              );

              const job = yield* call(() => client.read("jobs.get", { jobId: created.jobId })).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("200 millis"),
                  until: (current) => current.status !== "pending" && current.status !== "running",
                  times: 150,
                }),
              );

              const libraries = yield* call(() => client.read("libraries.list", {}));

              return {
                job,
                library: libraries.find((candidate) => candidate.id === created.libraryId),
              };
            });

          const owner = yield* scan(`Owner${suffix}`, root);

          expect(owner.job.status).toBe("done");
          expect(owner.library?.trackCount).toBe(10);

          // A link to the folder around it: a different path, the same files.
          yield* Files.makeSymlink(join(root, ".."), join(links, "around"));
          const alias = yield* scan(`Alias${suffix}`, join(links, "around"));

          expect(alias.job).toMatchObject({ status: "failed" });
          expect(alias.job.error).toMatch(/another library's folder/u);
          expect(alias.library?.trackCount).toBe(0);

          // /proc/self/root names the whole file system again; such a folder is never added.
          const proc = yield* call(() =>
            client
              .run("libraries.create", { name: `Proc${suffix}`, path: `/proc/self/root${root}` })
              .then(
                () => "added",
                // The Convex client rejects with a ConvexError, which is an Error.
                (error: Error) => error.message,
              ),
          );

          expect(proc).toMatch(/\/proc, \/sys, or \/dev/u);
        }),
      ));
  },
);
