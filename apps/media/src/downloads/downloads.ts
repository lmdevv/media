import { createHash, randomBytes } from "node:crypto";

import type { MediaFileId, PlaybackSessionId } from "@media/contracts/ids";
import {
  DownloadPreparing,
  DownloadReady,
  type FileResolverUnavailable,
  type InsufficientTranscodeSpace,
  type MediaFileNotFound,
  type PlaybackSessionEnded,
  type PlaybackTokenInvalid,
  type PrepareDownloadRequest,
  type PrepareDownloadResponse,
  TranscodeFailed,
  UnsupportedPlayback,
} from "@media/contracts/media-playback";
import { PERSONAL_TICKET_MAX_MS } from "@media/contracts/ticket";
import {
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Semaphore,
} from "effect";

import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import { MediaToolFailed } from "../media/media-tools.ts";
import * as FileResolver from "../playback/file-resolver.ts";
import { type CheckedMediaFile, resolveInsideRoots } from "../playback/file-resolver.ts";
import * as HardwareAcceleration from "../playback/hardware-acceleration.ts";
import { AudioPlan, VideoPlan } from "../playback/playback-decision.ts";
import { subtitleViews } from "../playback/playback-negotiator.ts";
import * as EndedSessions from "../playback/ended-sessions.ts";
import * as PlaybackToken from "../playback/playback-grants.ts";
import * as TranscodeSpace from "../playback/transcode-space.ts";
import { mp4CommandArgs } from "../playback/transcode-command.ts";
import { decideDownload, DownloadPlan } from "./download-plan.ts";

type PrepareError =
  | PlaybackTokenInvalid
  | PlaybackSessionEnded
  | MediaFileNotFound
  | FileResolverUnavailable
  | UnsupportedPlayback
  | InsufficientTranscodeSpace
  | TranscodeFailed;

/** Prepares downloads and finds the MP4s it wrote. */
export interface Interface {
  /** Where the download of the token's file stands; starts writing its MP4 when needed. */
  readonly prepare: (
    request: PrepareDownloadRequest,
  ) => Effect.Effect<PrepareDownloadResponse, PrepareError>;
  /** The finished MP4 `name` (`<key>.mp4`) of `fileId`, or none. */
  readonly output: (fileId: MediaFileId, name: string) => Effect.Effect<Option.Option<string>>;
}

/** The downloads service. */
export class Service extends Context.Service<Service, Interface>()("@media/server/Downloads") {}

const KEEP_UNUSED = Duration.hours(6);

const ABANDONED_AFTER = Duration.millis(PERSONAL_TICKET_MAX_MS);

const ENDED_GRACE = Duration.minutes(2);

const STALLED_AFTER = Duration.minutes(10);

const FAILED_COOLDOWN = Duration.minutes(10);

const SWEEP_EVERY = Duration.minutes(1);

const PROGRESS_TAIL_BYTES = 4096;

const PROGRESS_EVERY = Duration.seconds(1);

const MOST_PROGRESS = 0.99;

const OUTPUT_NAME = /^([a-f0-9]{24})\.mp4$/u;

class Mp4Stalled extends Data.TaggedError("Mp4Stalled") {}

type JobState = Data.TaggedEnum<{
  Queued: {};
  Running: {};
  Finished: { readonly sizeBytes: number };
  Failed: { readonly error: TranscodeFailed; readonly at: number };
}>;

const JobState = Data.taggedEnum<JobState>();

interface Job {
  readonly key: string;
  readonly name: string;
  readonly fileId: MediaFileId;
  readonly output: string;
  readonly estimatedBytes: number;
  readonly progress: Ref.Ref<number>;
  readonly state: Ref.Ref<JobState>;
  readonly lastUsed: Ref.Ref<number>;
  readonly writer: Ref.Ref<Option.Option<Fiber.Fiber<void>>>;
}

/** The last `out_time_us` in ffmpeg's `-progress` output, in seconds. */
export const progressSeconds = (text: string): number | undefined => {
  const matches = [...text.matchAll(/^out_time_us=(\d+)$/gmu)];
  const last = matches.at(-1)?.[1];

  return last === undefined ? undefined : Number(last) / 1_000_000;
};

const keyOf = (file: CheckedMediaFile, plan: DownloadPlan): string =>
  createHash("sha256")
    .update(JSON.stringify([file.fileId, file.sizeBytes, file.modifiedAtMs, plan]))
    .digest("hex")
    .slice(0, 24);

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const verifier = yield* PlaybackToken.Service;
  const resolver = yield* FileResolver.Service;
  const hardware = yield* HardwareAcceleration.Service;
  const tools = yield* MediaTools.Service;
  const space = yield* TranscodeSpace.Service;
  const ended = yield* EndedSessions.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const jobs = yield* Ref.make<ReadonlyMap<string, Job>>(new Map());
  const held = yield* Ref.make<ReadonlyMap<PlaybackSessionId, Job>>(new Map());
  const queue = yield* Semaphore.make(1);
  const root = path.join(config.transcodeDir, "downloads");

  const forget = (job: Job) =>
    Ref.update(jobs, (current) => {
      if (current.get(job.key) !== job) return current;
      const next = new Map(current);
      next.delete(job.key);

      return next;
    });

  const touch = (job: Job) =>
    Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(job.lastUsed, now)));

  const write = (
    job: Job,
    file: CheckedMediaFile,
    plan: Extract<DownloadPlan, { _tag: "Mp4" }>,
  ) => {
    const part = `${job.output}.part`;
    const progress = `${job.output}.progress`;
    const video = file.probe.video;
    const audioIndex = AudioPlan.$is("None")(plan.audio) ? undefined : plan.audio.index;
    const duration = Math.max(1, file.probe.durationSeconds);

    // ffmpeg appends to the file for the whole run; only its end holds the latest report.
    const readTail = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(progress);
        const size = Number((yield* handle.stat).size);
        const start = Math.max(0, size - PROGRESS_TAIL_BYTES);
        const bytes = yield* handle.readAlloc(size - start, { position: BigInt(start) });

        return Option.match(bytes, {
          onNone: () => "",
          onSome: (read) => new TextDecoder().decode(read),
        });
      }),
    );

    const run = Effect.gen(function* () {
      yield* Ref.set(job.state, JobState.Running());
      yield* space.reserve(job.name, job.estimatedBytes);
      yield* fs.makeDirectory(path.dirname(job.output), { recursive: true });

      const written = yield* Ref.make(0);
      const advancedAt = yield* Ref.make(yield* Clock.currentTimeMillis);

      const readProgress = readTail.pipe(
        Effect.map(progressSeconds),
        Effect.flatMap((seconds) =>
          Effect.gen(function* () {
            if (seconds === undefined || seconds <= (yield* Ref.get(written))) return;
            yield* Ref.set(written, seconds);
            yield* Ref.set(advancedAt, yield* Clock.currentTimeMillis);
            yield* Ref.set(job.progress, Math.min(MOST_PROGRESS, seconds / duration));
          }),
        ),
        Effect.ignore,
      );

      const watchdog = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        // At the end, `+faststart` rewrites the file and reports no further time.
        if ((yield* Ref.get(written)) >= duration - 1) return false;

        return now - (yield* Ref.get(advancedAt)) > Duration.toMillis(STALLED_AFTER);
      }).pipe(
        Effect.repeat({ schedule: Schedule.spaced(PROGRESS_EVERY), until: (stalled) => stalled }),
        Effect.andThen(Effect.fail(new Mp4Stalled())),
      );

      yield* readProgress.pipe(
        Effect.repeat(Schedule.spaced(PROGRESS_EVERY)),
        Effect.delay(PROGRESS_EVERY),
        Effect.forkScoped,
      );

      const ffmpeg = tools.ffmpegInBackground(
        mp4CommandArgs({
          input: file.path,
          videoIndex: video?.index ?? 0,
          videoCodec: video?.codec ?? "",
          videoBitDepth: video?.bitDepth ?? 8,
          video: plan.video,
          audio: plan.audio,
          audioCodec: file.probe.audio.find((track) => track.index === audioIndex)?.codec ?? "",
          qsvDevice: config.qsvDevice,
          vaapiDevice: config.vaapiDevice,
          output: part,
          progress,
        }),
      );

      yield* Effect.raceFirst(ffmpeg, watchdog);
      yield* fs.rename(part, job.output);
      const info = yield* fs.stat(job.output);

      yield* Ref.set(job.state, JobState.Finished({ sizeBytes: Number(info.size) }));
    }).pipe(Effect.scoped);

    const cleanup = <E>(exit: Exit.Exit<void, E>) =>
      Effect.gen(function* () {
        yield* fs.remove(progress).pipe(Effect.ignore);

        if (Exit.isSuccess(exit)) return;
        yield* fs.remove(part).pipe(Effect.ignore);

        if (Cause.hasInterrupts(exit.cause)) return;
        const failure = Cause.squash(exit.cause);

        yield* Effect.logWarning("Downloads.mp4_failed").pipe(
          Effect.annotateLogs({ fileId: job.fileId, mode: plan.mode }),
        );

        yield* Ref.set(
          job.state,
          JobState.Failed({
            error: new TranscodeFailed({
              streamId: job.name,
              mode: plan.mode,
              detail:
                failure instanceof MediaToolFailed
                  ? failure.stderr.trim().slice(-400)
                  : "The download could not be written",
            }),
            at: yield* Clock.currentTimeMillis,
          }),
        );
        yield* touch(job);
      });

    return queue
      .withPermits(1)(run.pipe(Effect.onExit(cleanup), Effect.ensuring(space.release(job.name))))
      .pipe(Effect.ignore);
  };

  const abandon = Effect.fnUntraced(function* (job: Job, reason: "ended" | "replaced" | "idle") {
    yield* forget(job);
    yield* Effect.logInfo("Downloads.mp4_abandoned").pipe(
      Effect.annotateLogs({ fileId: job.fileId, reason }),
    );

    const writer = yield* Ref.get(job.writer);

    if (Option.isSome(writer)) yield* Fiber.interrupt(writer.value);
  });

  const heldBy = (sessions: ReadonlyMap<PlaybackSessionId, Job>, job: Job) =>
    [...sessions.values()].includes(job);

  const unsettled = (job: Job) =>
    Ref.get(job.state).pipe(
      Effect.map((state) => JobState.$is("Queued")(state) || JobState.$is("Running")(state)),
    );

  const hold = Effect.fnUntraced(function* (sessionId: PlaybackSessionId, job: Job | undefined) {
    const [previous, now] = yield* Ref.modify(
      held,
      (
        current,
      ): readonly [
        readonly [Job | undefined, ReadonlyMap<PlaybackSessionId, Job>],
        ReadonlyMap<PlaybackSessionId, Job>,
      ] => {
        const next = new Map(current);

        if (job === undefined) next.delete(sessionId);
        else next.set(sessionId, job);

        return [[current.get(sessionId), next], next];
      },
    );

    if (previous === undefined || previous === job || heldBy(now, previous)) return;

    if (yield* unsettled(previous)) yield* abandon(previous, "replaced");
  });

  const jobFor = Effect.fnUntraced(function* (
    file: CheckedMediaFile,
    plan: Extract<DownloadPlan, { _tag: "Mp4" }>,
  ) {
    const key = keyOf(file, plan);
    const known = yield* Ref.get(jobs);
    const existing = known.get(key);

    if (existing !== undefined) return existing;

    const queued = yield* Effect.filter(known.values(), (job) =>
      Ref.get(job.state).pipe(Effect.map(JobState.$is("Queued"))),
    );

    yield* space.check(
      queued.reduce((total, job) => total + job.estimatedBytes, plan.estimatedBytes),
    );

    const name = randomBytes(12).toString("hex");

    const fresh: Job = {
      key,
      name,
      fileId: file.fileId,
      output: path.join(root, file.fileId, `${name}.mp4`),
      estimatedBytes: plan.estimatedBytes,
      progress: yield* Ref.make(0),
      state: yield* Ref.make<JobState>(JobState.Queued()),
      lastUsed: yield* Ref.make(yield* Clock.currentTimeMillis),
      writer: yield* Ref.make(Option.none<Fiber.Fiber<void>>()),
    };

    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const [job, started] = yield* Ref.modify(
          jobs,
          (current): readonly [readonly [Job, boolean], ReadonlyMap<string, Job>] => {
            const raced = current.get(key);

            return raced === undefined
              ? [[fresh, true], new Map(current).set(key, fresh)]
              : [[raced, false], current];
          },
        );

        if (started) {
          const fiber = yield* write(job, file, plan).pipe(
            Effect.interruptible,
            Effect.forkIn(scope),
          );

          yield* Ref.set(job.writer, Option.some(fiber));
        }

        return job;
      }),
    );
  });

  const prepare = Effect.fn("Downloads.prepare")(function* (request: PrepareDownloadRequest) {
    const grant = yield* verifier.verify(request.token, PlaybackToken.DOWNLOAD);

    const file = yield* resolveInsideRoots(grant.fileId, { sidecars: true }).pipe(
      Effect.provideService(FileResolver.Service, resolver),
      Effect.provideService(MediaConfig.Service, config),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

    yield* Effect.annotateCurrentSpan({ fileId: grant.fileId, sessionId: grant.sessionId });

    const plan = decideDownload(file.probe, request.capabilities, request.quality, {
      audioIndex: request.audioStreamIndex,
      softwareToneMapping: yield* hardware.softwareToneMapping,
      sizeBytes: file.sizeBytes,
    });

    const video = file.probe.video;

    if (DownloadPlan.$is("Unsupported")(plan) || video === undefined) {
      return yield* new UnsupportedPlayback({
        reason: DownloadPlan.$is("Unsupported")(plan) ? plan.reason : "no-video-stream",
      });
    }

    const base = config.mediaBaseUrl;

    const subtitles = () =>
      subtitleViews(file, base, request.token, verifier.withToken).flatMap((view) =>
        view.url === undefined ? [] : [{ ...view, url: view.url }],
      );

    const sourceVideo = {
      codec: video.codec,
      width: video.width,
      height: video.height,
      dynamicRange: video.dynamicRange,
    };

    const audioOf = (index: number | undefined, converted: boolean) => {
      const track = file.probe.audio.find((candidate) => candidate.index === index);

      return track === undefined
        ? undefined
        : {
            streamIndex: track.index,
            codec: converted ? "aac" : track.codec,
            channels: converted ? 2 : track.channels,
          };
    };

    if (DownloadPlan.$is("Original")(plan)) {
      yield* hold(grant.sessionId, undefined);
      const defaultAudio = file.probe.audio.find((track) => track.default) ?? file.probe.audio[0];

      return DownloadReady.make({
        durationSeconds: file.probe.durationSeconds,
        subtitles: subtitles(),
        expiresAt: grant.expiresAt,
        mode: "direct",
        url: verifier.withToken(`${base}/media/direct/${grant.fileId}`, request.token),
        sizeBytes: file.sizeBytes,
        container: file.probe.container,
        video: sourceVideo,
        audio: audioOf(defaultAudio?.index, false),
      });
    }

    const found = yield* jobFor(file, plan);
    const now = yield* Clock.currentTimeMillis;
    const before = yield* Ref.get(found.state);

    const retry =
      JobState.$is("Failed")(before) && now - before.at >= Duration.toMillis(FAILED_COOLDOWN);

    if (retry) yield* forget(found);
    const job = retry ? yield* jobFor(file, plan) : found;

    yield* hold(grant.sessionId, job);
    yield* touch(job);
    const state = yield* Ref.get(job.state);

    if (JobState.$is("Failed")(state)) return yield* state.error;

    if (!JobState.$is("Finished")(state)) {
      return DownloadPreparing.make({
        progress: yield* Ref.get(job.progress),
        estimatedBytes: job.estimatedBytes,
      });
    }

    return DownloadReady.make({
      durationSeconds: file.probe.durationSeconds,
      subtitles: subtitles(),
      expiresAt: grant.expiresAt,
      mode: plan.mode,
      url: verifier.withToken(
        `${base}/media/downloads/${grant.fileId}/${job.name}.mp4`,
        request.token,
      ),
      sizeBytes: state.sizeBytes,
      container: "mp4",
      video: VideoPlan.$match(plan.video, {
        Copy: () => sourceVideo,
        Encode: ({ width, height }) => ({
          codec: "h264",
          width,
          height,
          dynamicRange: "sdr" as const,
        }),
      }),
      audio: AudioPlan.$match(plan.audio, {
        None: () => undefined,
        Copy: ({ index }) => audioOf(index, false),
        Aac: ({ index }) => audioOf(index, true),
      }),
    });
  });

  const output = Effect.fn("Downloads.output")(function* (fileId: MediaFileId, name: string) {
    const wanted = OUTPUT_NAME.exec(name)?.[1];

    const job =
      wanted === undefined
        ? undefined
        : [...(yield* Ref.get(jobs)).values()].find((candidate) => candidate.name === wanted);

    if (job?.fileId !== fileId || !JobState.$is("Finished")(yield* Ref.get(job.state))) {
      return Option.none<string>();
    }

    yield* touch(job);

    return Option.some(job.output);
  });

  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const over = yield* Effect.filter([...(yield* Ref.get(held)).keys()], ended.isEnded, {
      concurrency: "unbounded",
    });

    const live = yield* Ref.updateAndGet(held, (current) => {
      const next = new Map(current);

      for (const sessionId of over) next.delete(sessionId);

      return next;
    });

    for (const job of (yield* Ref.get(jobs)).values()) {
      const idle = now - (yield* Ref.get(job.lastUsed));

      if (yield* unsettled(job)) {
        if (!heldBy(live, job) && idle > Duration.toMillis(ENDED_GRACE)) {
          yield* abandon(job, "ended");
        } else if (idle > Duration.toMillis(ABANDONED_AFTER)) yield* abandon(job, "idle");
      } else if (idle > Duration.toMillis(KEEP_UNUSED)) {
        yield* forget(job);
        yield* fs.remove(job.output).pipe(Effect.ignore);
      }
    }
  });

  yield* sweep.pipe(
    Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
    Effect.delay(SWEEP_EVERY),
    Effect.forkScoped,
  );

  return Service.of({ prepare, output });
});

/** Downloads over the media tools, the file resolver, and the token verifier. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | PlaybackToken.Service
  | FileResolver.Service
  | HardwareAcceleration.Service
  | MediaTools.Service
  | TranscodeSpace.Service
  | EndedSessions.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(Service, make);
