import { join } from "node:path";

import { NotFound } from "@media/contracts/errors";
import type { JobId } from "@media/contracts/ids";
import { HealthResponse, MEDIA_ROUTES } from "@media/contracts/media-playback";
import type { Backup } from "@media/contracts/models/jobs";
import { Effect, Exit, Option, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MediaProcess } from "../testing/stack-processes.ts";
import {
  client,
  finished,
  openSession,
  runIn,
  signInOwner,
  type StackSession,
} from "../testing/stack-owner.ts";
import {
  buildServiceAndCli,
  fileInfo,
  findMediaStack,
  makeTempDir,
  removeDir,
  startMedia,
  waitForBody,
  writeText,
} from "../testing/stack-processes.ts";

const stack = findMediaStack();

const id = Math.random().toString(36).slice(2, 8);

const convexUrl = stack?.convexUrl ?? "";

const mediaUrl = stack?.mediaUrl ?? "";

const EXPIRED = "movies-nightly-2020-01-01T03-00-00-000Z.zip";

const PARTIAL = ".partial-movies-manual-2020-01-02T03-00-00-000Z.zip";

let scope: Scope.Closeable;

let owner: StackSession;

let media: MediaProcess;

let backupDir = "";

let taken: Backup;

const decodeHealth = Schema.decodeUnknownOption(Schema.fromJsonString(HealthResponse));

const connected = () =>
  waitForBody(
    `${mediaUrl}${MEDIA_ROUTES.health}`,
    (text) =>
      decodeHealth(text).pipe(
        Option.filter((health) => health.backend === "connected"),
        Option.getOrUndefined,
      ),
    60_000,
  );

const signedIn = async (): Promise<StackSession> => {
  const session = await Effect.runPromise(openSession(convexUrl, mediaUrl, scope));

  await runIn(session, signInOwner);

  return session;
};

const listBackups = (session: StackSession) =>
  runIn(
    session,
    Effect.flatMap(client, (movies) => movies.query("backups.list", {})),
  );

const profileNames = (session: StackSession) =>
  runIn(
    session,
    Effect.flatMap(client, (movies) => movies.query("profiles.list", {})),
  ).then((profiles) => profiles.map((profile) => profile.name));

const backUp = (session: StackSession) =>
  runIn(
    session,
    Effect.gen(function* () {
      const movies = yield* client;
      const { jobId } = yield* movies.mutate("backups.run", {});

      return yield* finished(jobId satisfies JobId, "90 seconds");
    }),
  );

describe.skipIf(stack === undefined)(
  "backups and restores against a real stack",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      buildServiceAndCli();
      backupDir = await makeTempDir("movies-backup-stack-");
      await writeText(join(backupDir, EXPIRED), "an expired archive");
      await writeText(join(backupDir, PARTIAL), "a partial export");
      scope = Scope.makeUnsafe();
      owner = await signedIn();
      media = startMedia({ ...stack?.mediaEnv, BACKUP_DIR: backupDir });
      await connected();
    }, 180_000);

    afterAll(async () => {
      await media.stop("SIGTERM");
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await removeDir(backupDir);
    }, 60_000);

    it("lists archives found in the folder at startup", async () => {
      await expect
        .poll(async () => (await listBackups(owner)).map((backup) => backup.fileName), {
          timeout: 30_000,
        })
        .toContain(EXPIRED);
    });

    it("backs up into a private archive, records it, and prunes past the retention", async () => {
      const job = await backUp(owner);

      expect(job.status, job.error ?? "").toBe("succeeded");
      expect(job.progress.done).toBe(job.progress.total);

      const backups = await listBackups(owner);
      const names = backups.map((backup) => backup.fileName);
      const newest = backups[0];

      expect(newest?.fileName).toMatch(/^movies-manual-.*\.zip$/u);
      expect(newest?.trigger).toBe("manual");
      expect(names).not.toContain(EXPIRED);
      taken = newest ?? expect.unreachable();

      expect(await fileInfo(join(backupDir, taken.fileName))).toEqual({
        size: taken.sizeBytes,
        mode: 0o600,
      });
      expect((await fileInfo(backupDir))?.mode).toBe(0o700);
      expect(await fileInfo(join(backupDir, EXPIRED))).toBeUndefined();
      expect(await fileInfo(join(backupDir, PARTIAL))).toBeUndefined();
    });

    it("restores the archive, ends every session, and keeps the service signed in", async () => {
      const after = `After backup ${id}`;

      await runIn(
        owner,
        Effect.flatMap(client, (movies) =>
          movies.mutate("profiles.create", { name: after, avatar: "blue", kids: false }),
        ),
      );

      expect(await profileNames(owner)).toContain(after);

      await runIn(
        owner,
        Effect.flatMap(client, (movies) => movies.media("backups.restore", { backupId: taken.id })),
      );

      const stale = await runIn(
        owner,
        Effect.flatMap(client, (movies) => movies.query("profiles.list", {})).pipe(Effect.exit),
      );

      expect(Exit.isFailure(stale)).toBe(true);

      const again = await signedIn();

      expect(await profileNames(again)).not.toContain(after);
      expect((await listBackups(again)).map((backup) => backup.fileName)).toContain(taken.fileName);

      await connected();
      const next = await backUp(again);

      expect(next.status, next.error ?? "").toBe("succeeded");
      expect(media.logs()).not.toContain(stack?.mediaEnv["CONVEX_SELF_HOSTED_ADMIN_KEY"] ?? "-");
      expect(media.logs()).not.toContain(stack?.mediaServiceKey ?? "-");
    });

    it("refuses a backup whose archive is gone", async () => {
      const session = await signedIn();

      const backups = await listBackups(session);
      const restorable = backups[0] ?? expect.unreachable();

      await removeDir(join(backupDir, restorable.fileName));

      const refused = await runIn(
        session,
        Effect.flatMap(client, (movies) =>
          movies.media("backups.restore", { backupId: restorable.id }),
        ).pipe(Effect.flip),
      );

      expect(refused).toBeInstanceOf(NotFound);
    });
  },
);
