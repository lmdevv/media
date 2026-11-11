import { join } from "node:path";

import {
  type ClientCapabilities,
  MEDIA_ROUTES,
  NegotiateRequest,
  NegotiateResponse,
} from "@media/contracts/media-playback";
import type { Platform } from "@media/sdk/effect";
import { Effect, Exit, Option, Redacted, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  core,
  eventually,
  issueServiceKey,
  personIn,
  runHost,
  startCoreServer,
} from "../testing/core-stack.ts";
import type { CoreServer, Person } from "../testing/core-stack.ts";
import {
  addFile,
  bytesDigest,
  fileDigest,
  linkFolder,
  makeWorkDir,
  removeDir,
} from "../testing/core-host.ts";
import { ffmpegAvailable, generateFixtureLibrary } from "../testing/fixture-library.ts";

const smallScreen: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 160,
  maxHeight: 90,
  hls: false,
  mse: true,
};

const encodeNegotiate = Schema.encodeSync(Schema.toCodecJson(NegotiateRequest));

const decodeNegotiated = Schema.decodeUnknownSync(Schema.toCodecJson(NegotiateResponse));

const Issued = Schema.Struct({ ticket: Schema.String, expiresAt: Schema.Finite });

let scope: Scope.Closeable;

let workDir = "";

let admin: Person;

let server: CoreServer;

let libraryId: Option.Option<Platform.Id<"libraries">> = Option.none();

const library = (): Platform.Id<"libraries"> =>
  Option.getOrThrowWith(libraryId, () => new Error("The fixture library was not created"));

let moviesRoot = "";

let directMovie = "";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const titlesOf = (platform: Platform.Interface, id: Platform.Id<"libraries">) =>
  run(
    platform.movies.titles.list({ paginationOpts: { numItems: 50, cursor: null }, libraryId: id }),
  ).then((page) => page.page);

const sessionIdOf = async (platform: Platform.Interface): Promise<string> =>
  (await run(platform.core.auth.sessions.current())).sessionId;

const negotiate = async (ticket: string) => {
  const response = await fetch(`${server.baseUrl}${MEDIA_ROUTES.negotiate}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      encodeNegotiate({ token: Redacted.make(ticket), capabilities: smallScreen, startSeconds: 0 }),
    ),
  });

  const body: unknown = await response.json();

  expect(response.status, JSON.stringify(body)).toBe(200);

  return decodeNegotiated(body);
};

const firstSegmentUrl = async (playlistUrl: string): Promise<string> => {
  const playlist = await fetch(playlistUrl);
  const text = await playlist.text();

  expect(playlist.status, text).toBe(200);

  const base = playlistUrl.slice(0, playlistUrl.lastIndexOf("/") + 1);
  const segment = text.split("\n").find((line) => line.includes(".m4s")) ?? "";

  return `${base}${segment}`;
};

const withTicket = (url: string, ticket: string): string => {
  const parsed = new URL(url);

  parsed.searchParams.set("ticket", ticket);

  return parsed.toString();
};

const ScanEnd = Schema.Struct({ status: Schema.String, message: Schema.NullOr(Schema.String) });

type ScanEnd = typeof ScanEnd.Type;

/** A job once it has ended, as the core's admin read shows it. */
const ended = (jobId: string): Promise<ScanEnd> =>
  eventually(
    "the scan to end",
    async () => {
      const job = await runHost("core/jobs/admin:get", { jobId }, ScanEnd);

      return job.status === "succeeded" || job.status === "failed"
        ? Option.some(job)
        : Option.none();
    },
    120_000,
  );

/**
 * Asks for a scan of the fixture library as its admin and waits for it to end. A scan already
 * queued or running is joined whatever its mode, so this asks again until its own scan ran: the
 * server's startup rescan can leave one queued behind the first scan.
 */
const scanNow = async (mode: "incremental" | "full"): Promise<ScanEnd> => {
  const queued = await run(admin.platform.core.libraries.scan({ libraryId: library(), mode }));
  const job = await ended(queued.jobId);

  return queued.created ? job : scanNow(mode);
};

const health = async () => {
  const response = await fetch(`${server.baseUrl}${MEDIA_ROUTES.health}`);

  return Schema.decodeUnknownSync(
    Schema.Struct({ activeStreams: Schema.Finite, backend: Schema.String }),
  )(await response.json());
};

describe.skipIf(core === undefined || !(await ffmpegAvailable()))(
  "the server on the core's adapters",
  () => {
    beforeAll(async () => {
      scope = await run(Scope.make());
      workDir = await makeWorkDir("media-core-server-");

      const fixtures = await generateFixtureLibrary(join(workDir, "library"));

      moviesRoot = fixtures.moviesRoot;
      directMovie = fixtures.directMovie;
      admin = await personIn(scope, "admin");

      server = await startCoreServer(scope, {
        serviceKey: await issueServiceKey(),
        libraryRoot: join(workDir, "library"),
        workDir: join(workDir, "server"),
      });

      const created = await run(
        admin.platform.core.libraries.create({
          name: "Core fixtures",
          kind: "movies",
          folders: [moviesRoot],
        }),
      );

      libraryId = Option.some(created.libraryId);
    }, 180_000);

    afterAll(async () => {
      if (Option.isSome(libraryId)) {
        await run(
          admin.platform.core.libraries.remove({ libraryId: libraryId.value }).pipe(Effect.ignore),
        );
      }

      await run(Scope.close(scope, Exit.void));
      await removeDir(workDir);
    }, 60_000);

    it("signs in with its service key and scans the library into the core", async () => {
      await eventually("the server signs in", async () =>
        (await health()).backend === "connected" ? Option.some(true) : Option.none(),
      );

      const titles = await eventually(
        "the scan writes the fixture titles",
        async () => {
          const found = await titlesOf(admin.platform, library());

          return found.length >= 3 ? Option.some(found) : Option.none();
        },
        120_000,
      );

      expect(titles.map((title) => title.name)).toContain("HDR Fixture");
    }, 150_000);

    it("reads every file again on a full scan, unchanged ones included", async () => {
      const incremental = await scanNow("incremental");
      const full = await scanNow("full");

      expect(incremental).toMatchObject({ status: "succeeded" });
      expect(incremental.message).toMatch(/, 0 new or changed, [1-9]\d* unchanged/u);
      expect(full).toMatchObject({ status: "succeeded" });
      expect(full.message).toMatch(/, [1-9]\d* new or changed, 0 unchanged/u);
    }, 300_000);

    it("serves a stream to a ticket from movies.play.start and binds it to that ticket", async () => {
      const title = (await titlesOf(admin.platform, library())).find(
        (found) => found.name === "HDR Fixture",
      );

      if (title === undefined) throw new Error("No HDR fixture title");

      const started = await run(admin.platform.movies.play.start({ titleId: title.id }));
      const stream = await negotiate(started.ticket);

      expect(stream.mode).not.toBe("direct");
      expect(stream.url).toContain("ticket=");
      expect(stream.url).not.toContain("token=");

      const segment = await firstSegmentUrl(stream.url);
      const first = await fetch(segment);

      expect(first.status).toBe(200);
      expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(0);

      // Another start's ticket, valid for the same file, does not continue this stream. Tickets
      // hold whole seconds, so a start in the same second gets this very ticket.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const other = await run(admin.platform.movies.play.start({ titleId: title.id }));
      const foreign = await fetch(withTicket(segment, other.ticket));

      expect(foreign.status).toBe(401);

      // Nor does a download ticket for the same file.
      const download = await runHost(
        "core/ticketsProbe:issuePersonal",
        {
          sessionId: await sessionIdOf(admin.platform),
          resource: { kind: "file", id: started.file.id },
          purpose: "download",
        },
        Issued,
      );

      expect((await fetch(withTicket(segment, download.ticket))).status).toBe(401);
      expect((await fetch(segment)).status).toBe(200);
    }, 120_000);

    it("admits a download ticket with byte ranges, so a transfer resumes with a new ticket", async () => {
      const title = (await titlesOf(admin.platform, library())).find(
        (found) => found.name === "Big Buck Fixture",
      );

      if (title === undefined) throw new Error("No direct fixture title");

      const started = await run(admin.platform.movies.play.start({ titleId: title.id }));
      const sessionId = await sessionIdOf(admin.platform);

      const ticketFor = () =>
        runHost(
          "core/ticketsProbe:issuePersonal",
          { sessionId, resource: { kind: "file", id: started.file.id }, purpose: "download" },
          Issued,
        );

      const url = (ticket: string) =>
        `${server.baseUrl}/media/direct/${started.file.id}?ticket=${encodeURIComponent(ticket)}`;

      const first = await fetch(url((await ticketFor()).ticket), {
        headers: { range: "bytes=0-1023" },
      });

      expect(first.status).toBe(206);
      const head = Buffer.from(await first.arrayBuffer());

      const rest = await fetch(url((await ticketFor()).ticket), {
        headers: { range: "bytes=1024-" },
      });

      expect(rest.status).toBe(206);
      const tail = Buffer.from(await rest.arrayBuffer());

      const original = await fileDigest(
        join(moviesRoot, "Big Buck Fixture (2008)/Big Buck Fixture (2008).mp4"),
      );

      expect(bytesDigest(Buffer.concat([head, tail]))).toBe(original);
    }, 60_000);

    it("refuses a second library that lists the same folder through a link", async () => {
      const linked = join(workDir, "library-link");

      await linkFolder(moviesRoot, linked);

      const created = await run(
        admin.platform.core.libraries.create({
          name: "Same folder, other path",
          kind: "movies",
          folders: [linked],
        }),
      );

      try {
        const scan = await eventually(
          "the second library's scan ends",
          async () => {
            const found = await run(
              admin.platform.core.libraries.get({ libraryId: created.libraryId }),
            );

            const status = found.scan?.status;

            return status === "failed" || status === "succeeded"
              ? Option.some(found.scan)
              : Option.none();
          },
          60_000,
        );

        expect(scan?.status).toBe("failed");
        expect(await titlesOf(admin.platform, created.libraryId)).toHaveLength(0);
      } finally {
        await run(
          admin.platform.core.libraries
            .remove({ libraryId: created.libraryId })
            .pipe(Effect.ignore),
        );
      }
    }, 90_000);

    it("ends a person's streams when their session ends, before the ticket expires", async () => {
      const viewer = await personIn(scope, "admin", "viewer");

      const viewerId = (await run(viewer.platform.core.auth.sessions.current())).userId;

      await run(
        admin.platform.core.permissions.grants.set({
          resource: { type: "library", id: library() },
          principal: { kind: "user", userId: viewerId },
          level: "view",
        }),
      );

      const title = (await titlesOf(viewer.platform, library())).find(
        (found) => found.name === "HDR Fixture",
      );

      if (title === undefined) throw new Error("The viewer sees no HDR fixture");

      const started = await run(viewer.platform.movies.play.start({ titleId: title.id }));
      const stream = await negotiate(started.ticket);
      const segment = await firstSegmentUrl(stream.url);

      expect((await fetch(segment)).status).toBe(200);
      expect((await health()).activeStreams).toBeGreaterThan(0);

      const signedOutAt = Date.now();

      await run(viewer.platform.session.signOut);

      await eventually(
        "the stream stops once the session ends",
        async () => {
          const status = (await fetch(segment)).status;

          return status === 200 ? Option.none() : Option.some(status);
        },
        30_000,
      );

      expect(Date.now()).toBeLessThan(started.expiresAt);
      expect(Date.now() - signedOutAt).toBeLessThan(30_000);
    }, 90_000);

    it("asks the core to rescan the library when a file appears in its folder", async () => {
      const added = join(moviesRoot, "Rescan Fixture (2021)", "Rescan Fixture (2021).mp4");

      await addFile(join(moviesRoot, directMovie), added);

      const titles = await eventually(
        "the change's scan writes the new title",
        async () => {
          const found = await titlesOf(admin.platform, library());

          return found.some((title) => title.name === "Rescan Fixture")
            ? Option.some(found)
            : Option.none();
        },
        60_000,
      );

      expect(titles.map((title) => title.name)).toContain("Rescan Fixture");
      expect(server.logged().some((line) => line.includes("CoreRescans.queued"))).toBe(true);
    }, 90_000);

    it("keeps tickets and keys out of the log", () => {
      const lines = server.logged().join("\n");

      expect(lines).not.toMatch(/t1\.[a-z0-9]+\.media\./u);
      expect(lines).not.toMatch(/mk_[a-z0-9]+\./u);
    });
  },
);
