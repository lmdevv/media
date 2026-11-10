import type { DomainItem } from "../../commands/access";
import { register } from "../../commands/movies/play";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { reachOf } from "../core/permissions/grants";
import { playableBy } from "../core/permissions/items";
import { issuePersonalTicket } from "../core/tickets";
import { registerWithArtworkTickets } from "./artwork";
import { BOUNDS } from "./bounds";
import { choosePlayableFile, presentEpisode, presentMediaFile, resolveEpisode } from "./present";
import { findProgress, nextWatchGeneration, reachedEnd, writeProgress } from "./viewing";

const NO_TITLE = "No such title";

const titleItem = (title: Doc<"titles">): DomainItem => ({
  domain: "movies",
  ref: { type: "title", id: title._id },
});

const episodeItem = (episode: Doc<"episodes">): DomainItem => ({
  domain: "movies",
  ref: { type: "episode", id: episode._id },
});

const fileItem = (file: Doc<"mediaFiles">): DomainItem => ({
  domain: "movies",
  ref: { type: "file", id: file._id },
});

const milliseconds = (value: number, what: string): number =>
  Number.isSafeInteger(value) && value >= 0
    ? value
    : fail("invalid_args", `${what} are whole milliseconds, 0 or more`);

/**
 * Whether `caller` may play `file` of `title`, decided through `can()` by the core's item rules.
 * A person in the household plays what their grants show them; a guest plays what their share
 * link covers, whether it names the title, the episode, or the file (ADR 0007).
 */
const mayPlayFile = async (
  decide: (item: DomainItem) => Promise<boolean>,
  title: Doc<"titles">,
  episode: Doc<"episodes"> | null,
  file: Doc<"mediaFiles">,
): Promise<boolean> => {
  const items = [
    fileItem(file),
    ...(episode === null ? [] : [episodeItem(episode)]),
    titleItem(title),
  ];

  const tried = async (index: number): Promise<boolean> => {
    const item = items[index];

    return item !== undefined && ((await decide(item)) || tried(index + 1));
  };

  return tried(0);
};

const liveTitle = async (db: DatabaseReader, file: Doc<"mediaFiles">) => {
  const title = await db.get(file.titleId);

  return title === null || title.purging === true ? fail("not_found", NO_TITLE) : title;
};

export const { start, report, reportOffline } = registerWithArtworkTickets(register, {
  start: async (ctx, { titleId, episodeId, fileId, capabilities }, caller) => {
    const found = await ctx.db.get(titleId);
    const title = found === null || found.purging === true ? fail("not_found", NO_TITLE) : found;
    const reach = await reachOf(ctx.db, caller);
    const decide = playableBy(ctx.db, reach);

    if (reach.lent === null && !(await decide(titleItem(title)))) {
      return fail("not_found", NO_TITLE);
    }

    const episode = await resolveEpisode(ctx.db, title, episodeId ?? null);
    const saved = await findProgress(ctx.db, caller.userId, title._id, episode?._id ?? null);

    const file = await choosePlayableFile(ctx.db, title, episode, fileId ?? null, {
      lastPlayed: saved?.fileId ?? null,
      client: capabilities ?? null,
    });

    if (!(await mayPlayFile(decide, title, episode, file))) {
      return fail("not_found", NO_TITLE);
    }

    const playbackId = crypto.randomUUID();

    // The ticket names this start's playback, so every start has its own ticket and stream.
    const ticket = await issuePersonalTicket(ctx, caller, {
      playback: playbackId,
      resource: { kind: "file", id: file._id },
      purpose: "play",
    });

    return {
      titleId: title._id,
      episodeId: episode?._id ?? null,
      episode: episode === null ? null : presentEpisode(episode, saved),
      file: presentMediaFile(file),
      resumePositionMs:
        saved === null || reachedEnd(saved.positionMs, saved.durationMs) ? 0 : saved.positionMs,
      playbackId,
      startedAt: Date.now(),
      ticket: ticket.ticket,
      expiresAt: ticket.expiresAt,
    };
  },
  report: async (ctx, { fileId, positionMs, durationMs, event, playbackId, startedAt }, caller) => {
    milliseconds(positionMs, "Positions");
    milliseconds(startedAt, "Start times");

    if (playbackId.length === 0 || playbackId.length > BOUNDS.playbackId) {
      return fail("invalid_args", "This playback id did not come from movies.play.start");
    }

    if (durationMs !== undefined) milliseconds(durationMs, "Durations");

    const file = (await ctx.db.get(fileId)) ?? fail("not_found", "No such file");
    const title = await liveTitle(ctx.db, file);
    const episode = file.episodeId === null ? null : await ctx.db.get(file.episodeId);

    if (
      !(await mayPlayFile(playableBy(ctx.db, await reachOf(ctx.db, caller)), title, episode, file))
    ) {
      return fail("not_found", "No such file");
    }

    const now = Date.now();
    const duration = durationMs ?? file.probe.durationMs;

    const receipt = await writeProgress(ctx, {
      userId: caller.userId,
      titleId: title._id,
      episodeId: file.episodeId,
      fileId: file._id,
      positionMs,
      durationMs: duration,
      watched: event === "ended" || reachedEnd(positionMs, duration),
      playedAt: now,
      origin: { playId: playbackId, startedAt: Math.min(startedAt, now) },
    });

    if (receipt.applied) await nextWatchGeneration(ctx, caller.userId, title._id);

    return receipt;
  },
  reportOffline: async (ctx, args, caller) => {
    milliseconds(args.positionMs, "Positions");
    milliseconds(args.durationMs, "Durations");
    milliseconds(args.playedAt, "Play times");
    milliseconds(args.sentAt, "Send times");

    const file = (await ctx.db.get(args.fileId)) ?? fail("not_found", "No such file");
    const title = await liveTitle(ctx.db, file);
    const episode = file.episodeId === null ? null : await ctx.db.get(file.episodeId);

    if (
      !(await mayPlayFile(playableBy(ctx.db, await reachOf(ctx.db, caller)), title, episode, file))
    ) {
      return fail("not_found", "No such file");
    }

    const now = Date.now();
    const playedAt = Math.min(Math.max(0, args.playedAt + (now - args.sentAt)), now);
    const saved = await findProgress(ctx.db, caller.userId, title._id, file.episodeId);

    if (saved !== null && saved.lastPlayedAt >= playedAt) {
      return { applied: false, watched: saved.watched };
    }

    const receipt = await writeProgress(ctx, {
      userId: caller.userId,
      titleId: title._id,
      episodeId: file.episodeId,
      fileId: file._id,
      positionMs: args.positionMs,
      durationMs: args.durationMs,
      watched: reachedEnd(args.positionMs, args.durationMs),
      playedAt,
      origin: null,
    });

    if (receipt.applied) await nextWatchGeneration(ctx, caller.userId, title._id);

    return receipt;
  },
});
