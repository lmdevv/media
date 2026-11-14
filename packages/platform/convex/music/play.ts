import { register } from "../../commands/music/play";
import type { Id } from "../_generated/dataModel";
import { fail } from "../core/lib/errors";
import { reachOf } from "../core/permissions/grants";
import { issuePersonalTicket } from "../core/tickets";
import { cost } from "./budget";
import { MUSIC_BOUNDS, TABLE_BYTES } from "./fit";
import { personMeter, playDecider, readDecided } from "./person";
import { musicStore } from "./write";

const NO_TRACK = "No such track";

/** Offline plays one report records at most, as old music's `devices.reconcile` took. */
const OFFLINE_PLAYS_MAX = 500;

/**
 * What recording one offline play costs besides reading its track: the lookup that finds it
 * recorded already, and its insert.
 */
const OFFLINE_PLAY_COST = cost(1, 1, TABLE_BYTES.plays, TABLE_BYTES.plays);

const milliseconds = (value: number, what: string): number =>
  Number.isSafeInteger(value) && value >= 0
    ? value
    : fail("invalid_args", `${what} are whole milliseconds, 0 or more`);

export const { start, report, reportOffline } = register({
  start: async (ctx, { trackId }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const store = musicStore(ctx.db, personMeter(reach));
    const track = await store.get("tracks", trackId);

    if (
      track === null ||
      track.missing ||
      !(await playDecider(ctx.db, reach, store.meter).decide(track))
    ) {
      return fail("not_found", NO_TRACK);
    }

    const playbackId = crypto.randomUUID();

    // The ticket names this start's playback, so every start has its own ticket and stream.
    const ticket = await issuePersonalTicket(ctx, caller, {
      playback: playbackId,
      resource: { kind: "track", id: track._id },
      purpose: "play",
    });

    return {
      trackId: track._id,
      playbackId,
      startedAt: Date.now(),
      ticket: ticket.ticket,
      expiresAt: ticket.expiresAt,
    };
  },
  report: async (ctx, { trackId, playbackId }, caller) => {
    if (playbackId.length === 0 || playbackId.length > MUSIC_BOUNDS.playbackId) {
      return fail("invalid_args", "This playback id did not come from music.play.start");
    }

    const reach = await reachOf(ctx.db, caller);
    const store = musicStore(ctx.db, personMeter(reach));
    const track = await store.get("tracks", trackId);

    if (track === null || !(await playDecider(ctx.db, reach, store.meter).decide(track))) {
      return fail("not_found", NO_TRACK);
    }

    const recorded = await store.first("plays", (q) =>
      q.withIndex("by_user_playback", (index) =>
        index.eq("userId", caller.userId).eq("playbackId", playbackId),
      ),
    );

    if (recorded !== null) return { recorded: false };

    await store.insertPlay({
      userId: caller.userId,
      trackId: track._id,
      albumId: track.albumId,
      playedAt: Date.now(),
      playbackId,
      offlineAt: null,
    });

    return { recorded: true };
  },
  reportOffline: async (ctx, { plays, sentAt }, caller) => {
    if (plays.length > OFFLINE_PLAYS_MAX) {
      return fail("invalid_args", `Report at most ${OFFLINE_PLAYS_MAX} plays at once`);
    }

    milliseconds(sentAt, "Send times");

    for (const play of plays) milliseconds(play.playedAt, "Play times");

    const reach = await reachOf(ctx.db, caller);
    const store = musicStore(ctx.db, personMeter(reach));
    const now = Date.now();

    const unique = [
      ...new Map(plays.map((play) => [`${play.trackId}@${play.playedAt}`, play])).values(),
    ];

    const decided = await readDecided(
      store,
      playDecider(ctx.db, reach, store.meter),
      unique.map((play) => play.trackId),
      cost(
        unique.length * OFFLINE_PLAY_COST.work.ranges,
        unique.length,
        unique.length * OFFLINE_PLAY_COST.readBytes,
        unique.length * OFFLINE_PLAY_COST.writeBytes,
      ),
    );

    const playable = new Map<Id<"tracks">, Id<"albums">>(
      decided.flatMap(({ track, allowed }) =>
        track !== null && allowed ? [[track._id, track.albumId] as const] : [],
      ),
    );

    const written = await Promise.all(
      unique.map(async (play) => {
        const albumId = playable.get(play.trackId);

        if (albumId === undefined) return false;

        const known = await store.first("plays", (q) =>
          q.withIndex("by_user_track_offline", (index) =>
            index
              .eq("userId", caller.userId)
              .eq("trackId", play.trackId)
              .eq("offlineAt", play.playedAt),
          ),
        );

        if (known !== null) return false;

        await store.insertPlay({
          userId: caller.userId,
          trackId: play.trackId,
          albumId,
          playedAt: Math.min(Math.max(0, play.playedAt + (now - sentAt)), now),
          playbackId: null,
          offlineAt: play.playedAt,
        });

        return true;
      }),
    );

    return { recorded: written.filter(Boolean).length };
  },
});
