import type { SessionStatus } from "@media/contracts/models/scan";
import { Effect, Layer, Stream } from "effect";

import * as SessionReports from "../playback/session-reports.ts";
import { SessionReport } from "../playback/stream-liveness.ts";
import * as MediaBackend from "./media-backend.ts";

const reportOf = (status: SessionStatus | null): SessionReport =>
  status === null || status.status === "ended"
    ? SessionReport.Ended()
    : SessionReport.Active({ state: status.state, positionMs: status.positionMs });

/**
 * Session reports from Convex: one point-lookup subscription per followed session, which Convex
 * re-runs only when that session's row changes, about every ten seconds while it plays and never
 * while it is paused.
 */
export const layer: Layer.Layer<SessionReports.Service, never, MediaBackend.Service> = Layer.effect(
  SessionReports.Service,
  Effect.gen(function* () {
    const backend = yield* MediaBackend.Service;

    return SessionReports.Service.of({
      follow: (sessionId) =>
        backend.subscribe("mediaService.sessionStatus", { sessionId }).pipe(Stream.map(reportOf)),
    });
  }),
);
