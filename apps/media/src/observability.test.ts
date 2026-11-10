import { createServer } from "node:http";

import { NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Console, Effect, FileSystem, Layer, Path, Predicate, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as Observability from "./observability.ts";
import { testConfigLayer } from "./testing/test-config.ts";

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

const secrets = {
  playbackToken: `${base64url('{"aud":"media"}')}.${base64url("signature-secret")}`,
  apiKey: "mk_AbCdEfGh_0123456789abcdefghijklmnopqrstuv",
  adminKey: "convex-self-hosted|0123456789abcdef0123456789abcdef0123456789abcdef",
  tmdbKey: "tmdb0123456789secretkey",
  plexToken: "plexSecretTokenValue",
  jellyfinToken: "jellyfinSecretTokenValue",
  password: "hunter2-password-value",
  inviteCode: "InviteCodeQ7mZ2xLp",
  coreTicket:
    "t1.k1.media.3600.7200.play.file.file1.s.user1.session1.y7LW3OF3tCfjBmsX5DHoBCSzsZWIP7vqhGVPwjkUgqM",
};

class ImportFailed extends Schema.TaggedError<ImportFailed>()("ImportFailed", {
  output: Schema.String,
}) {
  override get message(): string {
    return `convex import failed: ${this.output}`;
  }
}

const logEverySecret = Effect.gen(function* () {
  yield* Effect.logWarning(
    "Request.failed",
    `GET /media/hls/abc/1/index.m3u8?token=${secrets.playbackToken}`,
    `GET /media/hls/abc/1/0.m4s?ticket=${encodeURIComponent(secrets.coreTicket)}`,
    `a ticket in prose: ${secrets.coreTicket}`,
    `https://api.themoviedb.org/3/search/movie?query=x&api_key=${secrets.tmdbKey}`,
    `http://plex.local:32400/library/sections?X-Plex-Token=${secrets.plexToken}`,
    `Authorization: MediaBrowser Client="movies", Token="${secrets.jellyfinToken}"`,
    `Authorization: Bearer ${secrets.apiKey}`,
    `admin key ${secrets.adminKey}`,
    `import failed: {"user":"owner","password":"${secrets.password}"}`,
    `config apiKey: '${secrets.tmdbKey}'`,
    `invited by https://movies.example:3000/invite/${secrets.inviteCode}`,
    `RouteNotFound: GET //Invite/${secrets.inviteCode}?from=mail`,
    `signed out at https://movies.example/sign-in?redirect=%2FInvite%2F${secrets.inviteCode}`,
    "probe failed for /mnt/nas/Invite/Home Video.mkv and /srv/invite/Home Video.mkv",
    "copy from //nas/invite/HomeVideo.mkv to '/Invite/Home Video.mkv'",
  ).pipe(
    Effect.annotateLogs({
      apiKey: secrets.apiKey,
      ticket: secrets.coreTicket,
      password: secrets.password,
      nested: { authorization: `Bearer ${secrets.apiKey}`, password: secrets.password },
      fileId: "file_123",
    }),
  );

  for (const url of [
    `/INVITE/${secrets.inviteCode}`,
    `//invite/${secrets.inviteCode}`,
    `/invite//${secrets.inviteCode}/`,
    `/\\invite/${secrets.inviteCode}`,
    `\\\\invite/${secrets.inviteCode}`,
    `/%5Cinvite/${secrets.inviteCode}`,
    `/./invite/${secrets.inviteCode}`,
  ]) {
    yield* Effect.logInfo("HttpServer.response").pipe(Effect.annotateLogs({ "http.url": url }));
  }

  yield* Effect.logError("Backups.failed", Redacted.make(secrets.adminKey)).pipe(
    Effect.andThen(new ImportFailed({ output: `admin key ${secrets.adminKey}` })),
    Effect.catchCause((cause) => Effect.logError("Backups.failed", cause)),
  );
});

const recordingConsole = (lines: Array<string>): Console.Console => ({
  ...globalThis.console,
  log: (...args: ReadonlyArray<unknown>) => {
    lines.push(args.join(" "));
  },
});

interface Written {
  readonly console: string;
  readonly retained: string;
}

const runWriting = (
  effect: Effect.Effect<void, never, HttpClient.HttpClient>,
  env: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "movies-observability-" });
    const lines: Array<string> = [];

    yield* Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.provideMerge(
          Observability.layer,
          Layer.mergeAll(
            testConfigLayer({ DATA_DIR: dataDir, ...env }),
            FetchHttpClient.layer,
            Layer.succeed(FileSystem.FileSystem, fs),
            Layer.succeed(Path.Path, path),
          ),
        ),
      );

      yield* effect.pipe(Effect.provideContext(context));
    }).pipe(Effect.scoped, Effect.provideService(Console.Console, recordingConsole(lines)));

    const logs = path.join(dataDir, "logs");
    const names = (yield* fs.readDirectory(logs)).toSorted();

    const retained = yield* Effect.forEach(names, (name) =>
      fs.readFileString(path.join(logs, name)),
    );

    const written: Written = { console: lines.join("\n"), retained: retained.join("").trimEnd() };

    return written;
  }).pipe(Effect.orDie, Effect.scoped);

const runObserved = (
  effect: Effect.Effect<void, never, HttpClient.HttpClient>,
  env: Readonly<Record<string, string>>,
) => runWriting(effect, env).pipe(Effect.map((written) => written.console));

const otlpReceiver = Effect.acquireRelease(
  Effect.callback<{ readonly url: string; readonly bodies: Array<string>; close: () => void }>(
    (resume) => {
      const bodies: Array<string> = [];

      const server = createServer((request, response) => {
        const chunks: Array<Buffer> = [];

        request.on("data", (chunk: Buffer) => chunks.push(chunk));

        request.on("end", () => {
          const path = request.url ?? "";

          if (path.startsWith("/v1/")) {
            bodies.push(`${path} ${Buffer.concat(chunks).toString("utf8")}`);
          }

          response.writeHead(200, { "content-type": "application/json" }).end("{}");
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();

        if (address === null || Predicate.isString(address)) {
          resume(Effect.die("The OTLP receiver is not listening on a TCP port"));
        } else {
          resume(
            Effect.succeed({
              url: `http://127.0.0.1:${String(address.port)}`,
              bodies,
              close: () => server.close(),
            }),
          );
        }
      });
    },
  ),
  (receiver) => Effect.sync(receiver.close),
);

layer(NodeServices.layer, { excludeTestServices: true })("Observability", (it) => {
  it.effect("writes one JSON object per log line", () =>
    Effect.gen(function* () {
      const output = yield* runObserved(
        Effect.logInfo("JobWorker.ready").pipe(Effect.annotateLogs({ workerId: "w1" })),
        {},
      );

      expect(JSON.parse(output)).toMatchObject({
        message: "JobWorker.ready",
        level: "INFO",
        annotations: { workerId: "w1" },
      });
    }),
  );

  it.effect("keeps the same redacted lines in the retained log as on the console", () =>
    Effect.gen(function* () {
      const written = yield* runWriting(logEverySecret, {});

      expect(written.retained).toBe(written.console);
      expect(written.retained).toContain("Request.failed");

      for (const [name, secret] of Object.entries(secrets)) {
        expect(written.retained, name).not.toContain(secret);
      }
    }),
  );

  it.effect("keeps the same redacted lines with OTLP export on", () =>
    Effect.gen(function* () {
      const receiver = yield* otlpReceiver;

      const written = yield* runWriting(logEverySecret, {
        OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
      });

      expect(written.retained).toBe(written.console);
      expect(written.retained).toContain("Request.failed");

      for (const [name, secret] of Object.entries(secrets)) {
        expect(written.console, name).not.toContain(secret);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("keeps lines at LOG_LEVEL and above only", () =>
    Effect.gen(function* () {
      const written = yield* runWriting(
        Effect.all([Effect.logInfo("Quiet.info"), Effect.logWarning("Loud.warning")]),
        { LOG_LEVEL: "warn" },
      );

      expect(written.retained).toContain("Loud.warning");
      expect(written.retained).not.toContain("Quiet.info");
      expect(written.console).not.toContain("Quiet.info");
    }),
  );

  it.effect("never writes a token, API key, password, or admin key to the console", () =>
    Effect.gen(function* () {
      const output = yield* runObserved(logEverySecret, {});

      for (const [name, secret] of Object.entries(secrets)) {
        expect(output, name).not.toContain(secret);
      }

      expect(output).toContain("Request.failed");
      expect(output).toContain("Backups.failed");
      expect(output).toContain("api.themoviedb.org/3/search/movie?query=x");
      expect(output).toContain("file_123");
      expect(output).toContain("import failed:");
      expect(output).toContain("https://movies.example:3000/invite/<redacted>");
      expect(output).toContain("GET /Invite/<redacted>?from=mail");
      expect(output).toContain(
        "https://movies.example/sign-in?redirect=%2FInvite%2F%3Credacted%3E",
      );
      expect(output).toContain('"http.url":"/INVITE/<redacted>"');
      expect(output).toContain('"http.url":"/invite/<redacted>"');
      expect(output).toContain(
        "probe failed for /mnt/nas/Invite/Home Video.mkv and /srv/invite/Home Video.mkv",
      );
      expect(output).toContain("copy from //nas/invite/HomeVideo.mkv to '/Invite/Home Video.mkv'");
    }),
  );

  it.effect("exports spans and logs over OTLP without any secret", () =>
    Effect.gen(function* () {
      const receiver = yield* otlpReceiver;

      yield* runObserved(
        Effect.gen(function* () {
          yield* logEverySecret.pipe(
            Effect.withSpan("Backups.backup", { attributes: { trigger: "manual" } }),
          );

          // The HTTP client records `url.full` and `url.query` itself, as the HTTP server does.
          yield* HttpClient.get(
            `${receiver.url}/media/hls/abc/1/index.m3u8?token=${secrets.playbackToken}`,
            { headers: { "x-plex-token": secrets.plexToken } },
          ).pipe(Effect.orDie);

          for (const path of [
            `/invite/${secrets.inviteCode}`,
            `//INVITE/${secrets.inviteCode}`,
            `/sign-in?redirect=/invite/${secrets.inviteCode}`,
            `/sign-in?redirect=%2finvite%2F${secrets.inviteCode}`,
          ]) {
            yield* HttpClient.get(`${receiver.url}${path}`).pipe(Effect.orDie);
          }

          yield* new ImportFailed({ output: `admin key ${secrets.adminKey}` }).pipe(
            Effect.withSpan("Backups.restore", { attributes: { password: secrets.password } }),
            Effect.ignore,
          );
        }),
        { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url },
      );

      const exported = receiver.bodies.join("\n");

      expect(exported).toContain("/v1/traces");
      expect(exported).toContain("Backups.backup");
      expect(exported).toContain("Backups.restore");
      expect(exported).toContain("/media/hls/abc/1/index.m3u8");
      expect(exported).toContain("/invite/<redacted>");
      expect(exported).toContain("/INVITE/<redacted>");
      expect(exported).toContain("redirect=%2Finvite%2F%3Credacted%3E");
      expect(exported).toContain("/v1/logs");
      expect(exported).toContain("Request.failed");

      for (const [name, secret] of Object.entries(secrets)) {
        expect(exported, name).not.toContain(secret);
      }
    }).pipe(Effect.scoped),
  );
});
