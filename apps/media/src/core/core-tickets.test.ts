import { artworkTicketId } from "@media/contracts/artwork";
import { PlaybackSessionEnded, StreamId } from "@media/contracts/media-playback";
import { PlaybackTokenInvalid } from "@media/contracts/playback-token";
import { serverFunctions } from "@media/contracts/server-functions";
import type { SessionStatus } from "@media/contracts/server-functions";
import { loadTicketKeyRing } from "@media/contracts/ticket";
import { EpochMillis } from "@media/contracts/units";
import type { TicketPurpose } from "@media/contracts/ticket";
import { TICKET_TEST_KEYS } from "@media/contracts/ticket-vectors";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Stream,
  SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";

import * as ArtworkGate from "../artwork/artwork-gate.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as SessionReports from "../playback/session-reports.ts";
import { SessionReport } from "../playback/stream-liveness.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import { makeFakeCore, stream } from "../testing/fake-core.ts";
import * as CoreTickets from "./core-tickets.ts";

const HOUR = 60 * 60 * 1000;

const principal = { userId: "user1", sessionId: "session1" };

const STREAM = StreamId.make("aaaaaaaaaaaaaaaaaaaaaa");

const ring = () =>
  Effect.promise(async () => {
    const loaded = await loadTicketKeyRing(TICKET_TEST_KEYS.k1);

    if (!loaded.ok) throw new Error("The test keys are unusable");

    return loaded.value;
  });

const issue = (purpose: TicketPurpose, now: number, fileId = "file1") =>
  Effect.flatMap(ring(), (keys) =>
    Effect.promise(async () => {
      const issued = await keys.issuePersonal({
        principal,
        resource: { kind: "file", id: fileId },
        purpose,
        now,
        lifetimeMs: HOUR,
      });

      if (!issued.ok) throw new Error("The test ticket was not issued");

      return Redacted.make(issued.value.ticket);
    }),
  );

/** The adapter over a fake core whose session status the test sets. */
const setUp = (initial: SessionStatus) =>
  Effect.gen(function* () {
    const status = yield* SubscriptionRef.make(initial);

    const fake = yield* makeFakeCore([
      stream(serverFunctions.sessionStatus, () => SubscriptionRef.changes(status)),
    ]);

    const context = yield* Layer.build(
      CoreTickets.layer({
        ticketKeys: Redacted.make(TICKET_TEST_KEYS.k1),
        idle: Duration.seconds(30),
      }).pipe(Layer.provideMerge(StreamOwners.layer), Layer.provide(fake.layer)),
    );

    return {
      status,
      tokens: Context.get(context, PlaybackToken.Service),
      reports: Context.get(context, SessionReports.Service),
      owners: Context.get(context, StreamOwners.Service),
      gate: Context.get(context, ArtworkGate.Service),
    };
  });

const live = (guest = false): SessionStatus => ({
  state: "live",
  endsAt: EpochMillis.make(30 * 24 * HOUR),
  guest,
});

describe("CoreTickets", () => {
  it.effect("admits a play ticket as the household's stream of one playback", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(HOUR);
      const { tokens } = yield* setUp(live());
      const ticket = yield* issue("play", HOUR);

      const grant = yield* tokens.verify(ticket, PlaybackToken.PLAY);

      assert.strictEqual(String(grant.userId), "user1");
      assert.strictEqual(String(grant.fileId), "file1");
      assert.strictEqual(grant.audience, "household");
      assert.strictEqual(grant.purpose, "play");
      assert.match(String(grant.sessionId), /^t[0-9a-f]{32}$/u);
      assert.strictEqual(grant.expiresAt, 30 * 24 * HOUR);
      assert.strictEqual(tokens.param, "ticket");
      assert.notInclude(String(grant.sessionId), Redacted.value(ticket));

      yield* TestClock.adjust("1 second");
      const again = yield* tokens.verify(yield* issue("play", HOUR + 1000), PlaybackToken.PLAY);

      assert.notStrictEqual(again.sessionId, grant.sessionId);
    }).pipe(Effect.scoped),
  );

  it.effect("gives a guest's stream the guest audience", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(HOUR);
      const { tokens } = yield* setUp(live(true));

      const grant = yield* tokens.verify(yield* issue("play", HOUR), PlaybackToken.PLAY);

      assert.strictEqual(grant.audience, "guest");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a ticket whose session ended, and one for another purpose", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(HOUR);
      const ended = yield* setUp({ state: "ended" });

      const refused = yield* Effect.flip(
        ended.tokens.verify(yield* issue("play", HOUR), PlaybackToken.PLAY),
      );

      assert.instanceOf(refused, PlaybackSessionEnded);

      const { tokens } = yield* setUp(live());

      const download = yield* Effect.flip(
        tokens.verify(yield* issue("download", HOUR), PlaybackToken.PLAY),
      );

      assert.instanceOf(download, PlaybackTokenInvalid);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "continues a running stream past its ticket's expiry on that ticket alone, not another's",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(HOUR);
        const { tokens, owners } = yield* setUp(live());
        const ticket = yield* issue("play", HOUR);
        const grant = yield* tokens.verify(ticket, PlaybackToken.PLAY);

        yield* owners.opened(STREAM, grant.sessionId);
        yield* TestClock.setTime(3 * HOUR);

        const expired = yield* Effect.flip(tokens.verify(ticket, PlaybackToken.PLAY));

        assert.instanceOf(expired, PlaybackTokenInvalid);

        const continued = yield* tokens.verify(ticket, PlaybackToken.PLAY, STREAM);

        assert.strictEqual(continued.sessionId, grant.sessionId);

        const other = yield* issue("play", 3 * HOUR);
        const foreign = yield* Effect.flip(tokens.verify(other, PlaybackToken.PLAY, STREAM));

        assert.instanceOf(foreign, PlaybackTokenInvalid);

        const download = yield* issue("download", 3 * HOUR);
        const downloading = yield* Effect.flip(tokens.verify(download, PlaybackToken.PLAY, STREAM));

        assert.instanceOf(downloading, PlaybackTokenInvalid);

        yield* owners.closed(STREAM);

        const closed = yield* Effect.flip(tokens.verify(ticket, PlaybackToken.PLAY, STREAM));

        assert.instanceOf(closed, PlaybackTokenInvalid);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps direct play reading past its ticket's expiry only while it keeps reading", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(HOUR);
      const { tokens } = yield* setUp(live());
      const ticket = yield* issue("play", HOUR);

      yield* tokens.verify(ticket, PlaybackToken.PLAY_OR_DOWNLOAD, PlaybackToken.READ);
      yield* TestClock.setTime(2 * HOUR - 10_000);
      yield* tokens.verify(ticket, PlaybackToken.PLAY_OR_DOWNLOAD, PlaybackToken.READ);
      yield* TestClock.setTime(2 * HOUR + 10_000);

      const reading = yield* tokens.verify(
        ticket,
        PlaybackToken.PLAY_OR_DOWNLOAD,
        PlaybackToken.READ,
      );

      assert.strictEqual(reading.purpose, "play");

      const restart = yield* Effect.flip(tokens.verify(ticket, PlaybackToken.PLAY));

      assert.instanceOf(restart, PlaybackTokenInvalid);

      yield* TestClock.adjust("1 minute");

      const idle = yield* Effect.flip(
        tokens.verify(ticket, PlaybackToken.PLAY_OR_DOWNLOAD, PlaybackToken.READ),
      );

      assert.instanceOf(idle, PlaybackTokenInvalid);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a running stream's thumbnails and subtitles read past the ticket's expiry", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(HOUR);
      const { tokens, owners } = yield* setUp(live());
      const ticket = yield* issue("play", HOUR);
      const grant = yield* tokens.verify(ticket, PlaybackToken.PLAY);

      yield* owners.opened(STREAM, grant.sessionId);
      yield* TestClock.setTime(4 * HOUR);

      const thumbnails = yield* tokens.verify(ticket, PlaybackToken.PLAY, PlaybackToken.READ);

      assert.strictEqual(thumbnails.sessionId, grant.sessionId);

      yield* owners.closed(STREAM);
      yield* TestClock.adjust("1 minute");

      const after = yield* Effect.flip(
        tokens.verify(ticket, PlaybackToken.PLAY, PlaybackToken.READ),
      );

      assert.instanceOf(after, PlaybackTokenInvalid);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a running stream's ticket once its session ends", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(HOUR);
      const { tokens, owners, status } = yield* setUp(live());
      const ticket = yield* issue("play", HOUR);
      const grant = yield* tokens.verify(ticket, PlaybackToken.PLAY);

      yield* owners.opened(STREAM, grant.sessionId);
      yield* SubscriptionRef.set(status, { state: "ended" });

      const refused = yield* Effect.flip(tokens.verify(ticket, PlaybackToken.PLAY, STREAM));

      assert.instanceOf(refused, PlaybackSessionEnded);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a stream's session ended when it ends, or when it reaches its expiry", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(HOUR);
      const { tokens, reports, status } = yield* setUp(live());
      const signedOut = yield* tokens.verify(yield* issue("play", HOUR), PlaybackToken.PLAY);

      const ended = yield* reports
        .follow(signedOut.sessionId)
        .pipe(Stream.runHead, Effect.forkScoped);

      yield* SubscriptionRef.set(status, { state: "ended" });
      assert.deepStrictEqual(
        Option.map(yield* Fiber.join(ended), SessionReport.$is("Ended")),
        Option.some(true),
      );

      yield* SubscriptionRef.set(status, {
        state: "live",
        endsAt: EpochMillis.make(2 * HOUR),
        guest: false,
      });
      const expiring = yield* tokens.verify(yield* issue("play", HOUR), PlaybackToken.PLAY);

      const lapsed = yield* reports
        .follow(expiring.sessionId)
        .pipe(Stream.runHead, Effect.forkScoped);

      yield* TestClock.setTime(2 * HOUR);
      assert.isTrue(Option.isSome(yield* Fiber.join(lapsed)));
    }).pipe(Effect.scoped),
  );

  it.effect("admits shareable artwork tickets for the key's ticket id only", () =>
    Effect.gen(function* () {
      const now = 3 * 7 * 24 * HOUR;

      yield* TestClock.setTime(now);
      const { gate } = yield* setUp(live());
      const keys = yield* ring();
      const id = yield* Effect.promise(() => artworkTicketId("a1.poster"));

      const issued = yield* Effect.promise(() =>
        keys.issueShareable({ resource: { kind: "artwork", id }, now }),
      );

      assert.isTrue(yield* gate.admits(issued.ticket, "a1.poster"));
      assert.isFalse(yield* gate.admits(issued.ticket, "a1.backdrop"));
      assert.isFalse(yield* gate.admits("t1.nonsense", "a1.poster"));
    }).pipe(Effect.scoped),
  );
});
