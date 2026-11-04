import { PERSONAL_TICKET_MAX_MS } from "@media/contracts/ticket";
import type {
  SessionReader,
  TicketAdmission,
  TicketKeyRing,
  TicketRequest,
} from "@media/contracts/ticket";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { SESSION_MS } from "../../convex/core/sessions";
import { runFunction } from "../admin";
import { createPerson, signIn, signInAs } from "../sign-in";
import type { SignedIn } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { deploymentTicketKeys } from "../ticket-keys";
import type { CoreStack } from "../stack-env";

const stack = coreStackFromEnvFile();

const HOUR_MS = 60 * 60 * 1000;

const IssuedTicket = Schema.Struct({ ticket: Schema.String, expiresAt: Schema.Finite });

const SessionStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("live"), endsAt: Schema.Finite }),
  Schema.Struct({ state: Schema.Literal("ended") }),
]);

const ErrorCode = /"code":"(?<code>\w+)"/u;

const sessionStatus = (core: CoreStack, userId: string, sessionId: string) =>
  runFunction(core, internal.core.tickets.sessionStatus, { userId, sessionId }, SessionStatus);

const coreSessions =
  (core: CoreStack): SessionReader =>
  async ({ userId, sessionId }) =>
    (await sessionStatus(core, userId, sessionId)).state === "live" ? "live" : "ended";

const adminRefusal = async (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "accepted",
    (cause: unknown) =>
      (cause instanceof Error ? ErrorCode.exec(cause.message)?.groups?.["code"] : undefined) ??
      `failed: ${String(cause)}`,
  );

const currentSession = (signedIn: SignedIn) =>
  signedIn.client.query(api.core.auth.sessions.current, {});

const file = { kind: "file", id: "kd7ay8r0ty1ry6q9y6eqvdc3y97t2wmf" } as const;

const issuePlay = (core: CoreStack, sessionId: Id<"authSessions">, lifetimeMs?: number) =>
  runFunction(
    core,
    internal.core.ticketsProbe.issuePersonal,
    lifetimeMs === undefined
      ? { sessionId, resource: file, purpose: "play" }
      : { sessionId, resource: file, purpose: "play", lifetimeMs },
    IssuedTicket,
  );

const playRequest = (core: CoreStack, ticket: string): TicketRequest => ({
  ticket,
  route: { purposes: ["play"], resource: file },
  readSession: coreSessions(core),
});

const admitted = async (ring: TicketKeyRing, request: TicketRequest): Promise<TicketAdmission> => {
  const answer = await ring.admit(request, Date.now());

  if (!answer.ok) throw new Error(`Ticket refused: ${answer.error.reason}`);

  return answer.value;
};

describe.skipIf(stack === undefined)("tickets on a live core", { timeout: 120_000 }, () => {
  it("issues a personal ticket that names the session, admits, and continues", async () => {
    if (stack === undefined) return;
    const ring = await deploymentTicketKeys();
    const signedIn = await signInAs(stack, await createPerson(stack));
    const caller = await currentSession(signedIn);
    const { ticket } = await issuePlay(stack, caller.sessionId);
    const admission = await admitted(ring, playRequest(stack, ticket));

    expect(admission.claims).toMatchObject({
      kind: "personal",
      principal: { userId: caller.userId, sessionId: caller.sessionId },
      purpose: "play",
      resource: file,
    });
    expect((await admission.continue(ticket)).ok).toBe(true);
  });

  it("stops an admitted stream when its session signs out, before the ticket expires", async () => {
    if (stack === undefined) return;
    const ring = await deploymentTicketKeys();
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await currentSession(signedIn);
    const { ticket, expiresAt } = await issuePlay(stack, sessionId);
    const admission = await admitted(ring, playRequest(stack, ticket));

    await signedIn.client.action(api.auth.signOut, {});

    const continued = await admission.continue(ticket);
    const readmitted = await ring.admit(playRequest(stack, ticket), Date.now());

    expect(continued.ok ? "continued" : continued.error.reason).toBe("session_ended");
    expect(readmitted.ok ? "admitted" : readmitted.error.reason).toBe("session_ended");
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("reports sessions that endAll or a key revoke ended, and only the user's own", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const before = Date.now();
    const older = await currentSession(await signInAs(stack, person));
    const current = await signInAs(stack, person);
    const after = Date.now();
    const kept = await currentSession(current);
    const stranger = await currentSession(await signInAs(stack, await createPerson(stack)));
    const olderStatus = await sessionStatus(stack, older.userId, older.sessionId);

    expect(olderStatus.state).toBe("live");
    expect(olderStatus.state === "live" && olderStatus.endsAt).toBeGreaterThanOrEqual(
      before + SESSION_MS,
    );
    expect(olderStatus.state === "live" && olderStatus.endsAt).toBeLessThanOrEqual(
      after + SESSION_MS,
    );
    expect(await sessionStatus(stack, older.userId, stranger.sessionId)).toEqual({
      state: "ended",
    });
    expect(await sessionStatus(stack, older.userId, "not-a-session")).toEqual({ state: "ended" });

    await current.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: true });

    expect(await sessionStatus(stack, older.userId, older.sessionId)).toEqual({ state: "ended" });
    expect((await sessionStatus(stack, kept.userId, kept.sessionId)).state).toBe("live");

    const created = await current.client.action(api.core.auth.apiKeys.create, {
      name: "ticket test",
      scopes: ["account"],
      expiresInDays: 1,
    });

    const keySession = await currentSession(await signIn(stack, "apiKey", { key: created.key }));

    expect(await sessionStatus(stack, keySession.userId, keySession.sessionId)).toEqual({
      state: "live",
      endsAt: created.expiresAt,
    });

    await current.client.mutation(api.core.auth.apiKeys.revoke, { keyId: created.keyId });

    expect(await sessionStatus(stack, keySession.userId, keySession.sessionId)).toEqual({
      state: "ended",
    });
  });

  it("caps a personal ticket at 6 h and refuses a short lifetime or an ended session", async () => {
    if (stack === undefined) return;
    const ring = await deploymentTicketKeys();
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await currentSession(signedIn);
    const issued = await issuePlay(stack, sessionId, 7 * HOUR_MS);
    const admission = await admitted(ring, playRequest(stack, issued.ticket));

    expect(issued.expiresAt).toBe(admission.claims.expiresAt);
    expect(issued.expiresAt - admission.claims.issuedAt).toBeLessThanOrEqual(
      PERSONAL_TICKET_MAX_MS,
    );
    expect(await adminRefusal(issuePlay(stack, sessionId, 999))).toBe("invalid_args");

    await signedIn.client.action(api.auth.signOut, {});

    expect(await adminRefusal(issuePlay(stack, sessionId))).toBe("unauthenticated");
  });

  it("gives the same artwork URL in one bucket, naming no one", async () => {
    if (stack === undefined) return;
    const ring = await deploymentTicketKeys();
    const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const before = Date.now();

    const artworkUrl = async (): Promise<string> => {
      const { ticket } = await runFunction(
        stack,
        internal.core.ticketsProbe.issueShareable,
        { artworkId: hash },
        IssuedTicket,
      );

      return `https://media.example/artwork/${hash}?ticket=${ticket}`;
    };

    const first = await artworkUrl();
    const second = await artworkUrl();
    const ticket = new URL(first).searchParams.get("ticket") ?? "";

    // The deployment may answer the second call from its query cache, so the ticket is also
    // checked against one this process signs at another instant of the same bucket.
    const local = await ring.issueShareable({
      resource: { kind: "artwork", id: hash },
      now: before,
    });

    expect(second).toBe(first);
    expect(ticket).toBe(local.ticket);
    expect(ticket.split(".")[8]).toBe("a");
  });
});
