import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  loadTicketKeyRing,
  PERSONAL_TICKET_MAX_MS,
  PERSONAL_TICKET_MIN_MS,
  SHAREABLE_BUCKET_MS,
  TICKET_CLOCK_SKEW_MS,
  ticketPurposes,
  ticketRefusalReasons,
  ticketResourceKinds,
} from "./ticket";
import type {
  PersonalTicketRequest,
  IssuedTicket,
  SessionPrincipal,
  SessionReader,
  SessionState,
  TicketAdmission,
  TicketKeyRing,
  TicketKeysProblem,
  TicketRefusalReason,
  TicketRequest,
  TicketRoute,
  TicketKeysInvalid,
  TicketRefused,
} from "./ticket";
import { TICKET_TEST_KEYS, TICKET_TEST_VECTORS } from "./ticket-vectors";
import type { TicketVector } from "./ticket-vectors";

const ringOf = async (keys: string): Promise<TicketKeyRing> => {
  const loaded = await loadTicketKeyRing(keys);

  if (!loaded.ok) throw loaded.error;

  return loaded.value;
};

const personalOf = async (
  ring: TicketKeyRing,
  request: PersonalTicketRequest,
): Promise<IssuedTicket> => {
  const issued = await ring.issuePersonal(request);

  if (!issued.ok) throw issued.error;

  return issued.value;
};

const answering =
  (state: SessionState): SessionReader =>
  () =>
    Promise.resolve(state);

const live = answering("live");

const vectorNamed = (name: string): TicketVector => {
  const found = TICKET_TEST_VECTORS.find((vector) => vector.name === name);

  if (found === undefined) throw new Error(`No vector named ${name}`);

  return found;
};

const playVector = vectorNamed("a personal play ticket");

const playClaims = playVector.admits.ok ? playVector.admits.claims : null;

const playIssue = playVector.issue?.kind === "personal" ? playVector.issue.request : null;

if (playClaims === null || playIssue === null) throw new Error("The play vector must admit");

const downloadVector = vectorNamed("its download twin, on a route that serves both");

const artworkVector = vectorNamed("a shareable artwork ticket issued at its bucket's start");

const playRequest = (ticket: string, readSession: SessionReader = live): TicketRequest => ({
  ticket,
  route: playVector.route,
  readSession,
});

const reasonOf = async (ring: TicketKeyRing, request: TicketRequest, now: number) => {
  const admitted = await ring.admit(request, now);

  return admitted.ok ? "admitted" : admitted.error.reason;
};

const macOf = (ticket: string): string => ticket.slice(-43);

const refusedAfterMac = (reason: TicketRefusalReason): boolean =>
  ticketRefusalReasons.indexOf(reason) > ticketRefusalReasons.indexOf("bad_signature");

const userId = fc.stringMatching(/^[a-z0-9]{1,64}$/u);

const resourceId = fc.stringMatching(/^[\w-]{1,128}$/u);

const issueTime = fc.integer({ min: 0, max: 10 ** 14 });

const personalRequests = fc.record({
  principal: fc.record({ userId, sessionId: userId }),
  resource: fc.record({ kind: fc.constantFrom(...ticketResourceKinds), id: resourceId }),
  purpose: fc.constantFrom(...ticketPurposes),
  now: issueTime,
  lifetimeMs: fc.integer({ min: 1000, max: 2 * PERSONAL_TICKET_MAX_MS }),
});

const issueVector = async (
  ring: TicketKeyRing,
  vector: TicketVector,
): Promise<IssuedTicket | null> => {
  if (vector.issue === null) return null;

  if (vector.issue.kind === "personal") return personalOf(ring, vector.issue.request);

  return ring.issueShareable(vector.issue.request);
};

const admitVector = async (
  vector: TicketVector,
  readSession: SessionReader,
): Promise<TicketAdmission> => {
  const ring = await ringOf(vector.keys);

  const admitted = await ring.admit(
    { ticket: vector.ticket, route: vector.route, readSession },
    vector.now,
  );

  if (!admitted.ok) throw admitted.error;

  return admitted.value;
};

const shown = (
  value: TicketAdmission | TicketKeyRing | TicketKeysInvalid | TicketRefused,
): ReadonlyArray<string> => [
  JSON.stringify(value),
  value instanceof Error ? `${String(value)} ${value.stack ?? ""}` : "",
];

const keyTexts = [TICKET_TEST_KEYS.k1.slice(3), TICKET_TEST_KEYS.k2.slice(3)] as const;

const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const routeFor = (request: PersonalTicketRequest): TicketRoute => ({
  purposes: [request.purpose],
  resource: request.resource,
});

describe("ticket vectors", () => {
  it.each(TICKET_TEST_VECTORS.filter((vector) => vector.issue !== null))(
    "issues exactly the bytes of $name",
    async (vector) => {
      const issued = await issueVector(await ringOf(vector.keys), vector);

      expect(issued?.ticket).toBe(vector.ticket);
      expect(vector.admits.ok && vector.admits.claims.expiresAt).toBe(issued?.expiresAt);
    },
  );

  it.each(
    TICKET_TEST_VECTORS.filter(
      (vector) => vector.admits.ok || refusedAfterMac(vector.admits.reason),
    ),
  )("carries an HMAC that node:crypto computes for $name", (vector) => {
    const keyId = vector.ticket.split(".")[1];
    const entry = vector.keys.split(",").find((each) => each.startsWith(`${keyId}:`)) ?? "";
    const signed = vector.ticket.slice(0, vector.ticket.lastIndexOf("."));

    const mac = createHmac("sha256", Buffer.from(entry.slice(entry.indexOf(":") + 1), "base64url"))
      .update(signed, "ascii")
      .digest("base64url");

    expect(entry).not.toBe("");
    expect(macOf(vector.ticket)).toBe(mac);
  });

  it.each(TICKET_TEST_VECTORS)("answers $name exactly", async (vector) => {
    const ring = await ringOf(vector.keys);

    const admitted = await ring.admit(
      { ticket: vector.ticket, route: vector.route, readSession: answering(vector.session) },
      vector.now,
    );

    if (vector.admits.ok) {
      expect(admitted.ok && admitted.value.claims).toEqual(vector.admits.claims);
    } else {
      expect(admitted.ok ? "admitted" : admitted.error.reason).toBe(vector.admits.reason);
      expect(!admitted.ok && admitted.error.claims !== undefined).toBe(
        refusedAfterMac(vector.admits.reason),
      );
    }
  });

  it("lists the refusal reasons in the order the refused vectors meet them", () => {
    const met = [
      ...new Set(
        TICKET_TEST_VECTORS.flatMap((vector) => (vector.admits.ok ? [] : [vector.admits.reason])),
      ),
    ];

    expect([...met, "other_ticket"]).toEqual(ticketRefusalReasons);
  });

  it("answers the first failing check when several fail", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          purpose: fc.boolean(),
          resource: fc.boolean(),
          clock: fc.constantFrom("on_time", "not_yet_valid", "expired"),
          session: fc.constantFrom<SessionState>("live", "ended", "unavailable"),
        }),
        async (failing) => {
          const route: TicketRoute = {
            purposes: failing.purpose ? ["download"] : ["play"],
            resource: failing.resource ? { kind: "track", id: "other" } : playVector.route.resource,
          };

          const now = {
            on_time: playVector.now,
            not_yet_valid: playClaims.issuedAt - TICKET_CLOCK_SKEW_MS - 1,
            expired: playClaims.expiresAt,
          }[failing.clock];

          const expected =
            ticketRefusalReasons.find(
              (reason) =>
                (reason === "wrong_purpose" && failing.purpose) ||
                (reason === "wrong_resource" && failing.resource) ||
                reason === failing.clock ||
                (reason === "session_ended" && failing.session === "ended") ||
                (reason === "session_unavailable" && failing.session === "unavailable"),
            ) ?? "admitted";

          expect(
            await reasonOf(
              ring,
              { ticket: playVector.ticket, route, readSession: answering(failing.session) },
              now,
            ),
          ).toBe(expected);
        },
      ),
    );
  });
});

describe("issuing and admitting", () => {
  it("admits what it issues, with the claims it was asked for", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);

    await fc.assert(
      fc.asyncProperty(personalRequests, async (request) => {
        const issued = await personalOf(ring, request);

        const admitted = await ring.admit(
          { ticket: issued.ticket, route: routeFor(request), readSession: live },
          request.now,
        );

        expect(admitted.ok && admitted.value.claims).toEqual({
          kind: "personal",
          principal: request.principal,
          purpose: request.purpose,
          resource: request.resource,
          issuedAt: Math.floor(request.now / 1000) * 1000,
          expiresAt: issued.expiresAt,
        });
        const issuedAt = Math.floor(request.now / 1000) * 1000;

        expect(issued.expiresAt - issuedAt).toBeLessThanOrEqual(PERSONAL_TICKET_MAX_MS);
        expect(issued.expiresAt).toBeGreaterThanOrEqual(
          Math.min(request.now + request.lifetimeMs, issuedAt + PERSONAL_TICKET_MAX_MS),
        );
        expect(issued.expiresAt).toBeLessThan(request.now + request.lifetimeMs + 1000);
      }),
    );
  });

  it("refuses a ticket with any one character changed, inserted, or deleted", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);
    const { ticket } = playVector;

    const characters = fc.constantFrom(...`${base64UrlAlphabet}.`.split(""));

    const edits = fc.oneof(
      fc.record({
        at: fc.nat({ max: ticket.length - 1 }),
        edit: fc.constant("change"),
        character: characters,
      }),
      fc.record({
        at: fc.nat({ max: ticket.length }),
        edit: fc.constant("insert"),
        character: characters,
      }),
      fc.record({
        at: fc.nat({ max: ticket.length - 1 }),
        edit: fc.constant("delete"),
        character: fc.constant(""),
      }),
    );

    await fc.assert(
      fc.asyncProperty(edits, async ({ at, edit, character }) => {
        const edited =
          ticket.slice(0, at) + character + ticket.slice(edit === "insert" ? at : at + 1);

        fc.pre(edited !== ticket);

        expect(await reasonOf(ring, playRequest(edited), playVector.now)).not.toBe("admitted");
      }),
      { numRuns: 1000 },
    );
  });

  it("never admits a personal ticket before its issue less the skew, or 6 h after it", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);

    await fc.assert(
      fc.asyncProperty(
        personalRequests,
        fc.integer({ min: -2 * PERSONAL_TICKET_MAX_MS, max: 2 * PERSONAL_TICKET_MAX_MS }),
        async (request, offset) => {
          const issued = await personalOf(ring, { ...request, lifetimeMs: 10 ** 9 });
          const issuedAt = Math.floor(request.now / 1000) * 1000;
          const at = issuedAt + offset;

          const answer = await reasonOf(
            ring,
            { ticket: issued.ticket, route: routeFor(request), readSession: live },
            at,
          );

          expect(answer === "admitted").toBe(
            at >= issuedAt - TICKET_CLOCK_SKEW_MS && at < issuedAt + PERSONAL_TICKET_MAX_MS,
          );
        },
      ),
    );
  });

  it("caps a personal ticket at notAfter", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);

    await fc.assert(
      fc.asyncProperty(
        personalRequests,
        fc.integer({ min: 2000, max: PERSONAL_TICKET_MAX_MS }),
        async (request, ceiling) => {
          const issued = await personalOf(ring, { ...request, notAfter: request.now + ceiling });

          expect(issued.expiresAt).toBeLessThanOrEqual(request.now + ceiling);
          expect(issued.expiresAt % 1000).toBe(0);
          expect(issued.expiresAt).toBeGreaterThanOrEqual(request.now + PERSONAL_TICKET_MIN_MS);
        },
      ),
    );
  });

  it("issues one shareable ticket per bucket, valid one to two buckets from issue", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);

    await fc.assert(
      fc.asyncProperty(
        resourceId,
        fc.integer({ min: 0, max: Math.floor(10 ** 14 / SHAREABLE_BUCKET_MS) - 1 }),
        fc.nat({ max: SHAREABLE_BUCKET_MS - 1 }),
        fc.nat({ max: SHAREABLE_BUCKET_MS - 1 }),
        async (id, bucket, first, second) => {
          const resource = { kind: "artwork", id } as const;
          const start = bucket * SHAREABLE_BUCKET_MS;
          const one = await ring.issueShareable({ resource, now: start + first });
          const other = await ring.issueShareable({ resource, now: start + second });

          expect(other).toEqual(one);
          expect(one.expiresAt).toBeGreaterThanOrEqual(start + first + SHAREABLE_BUCKET_MS);
          expect(one.expiresAt).toBeLessThanOrEqual(start + first + 2 * SHAREABLE_BUCKET_MS);
          expect(one.ticket.split(".").at(-2)).toBe("a");
        },
      ),
    );
  });

  it("refuses an id outside its alphabet without echoing it", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);
    const request = playIssue;

    const calls = [
      () =>
        ring.issuePersonal({
          ...request,
          principal: { ...request.principal, userId: "Secret.Id" },
        }),
      () =>
        ring.issuePersonal({
          ...request,
          principal: { ...request.principal, sessionId: "Secret.Id" },
        }),
      () => ring.issuePersonal({ ...request, resource: { kind: "file", id: "Secret.Id" } }),
      () => ring.issueShareable({ resource: { kind: "artwork", id: "Secret.Id" }, now: 0 }),
    ];

    const failures = await Promise.all(
      calls.map((call) =>
        call().then(
          () => null,
          (cause: unknown) => cause,
        ),
      ),
    );

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(RangeError);
      expect(failure instanceof RangeError && failure.message).not.toContain("Secret");
    }
  });

  it("refuses a lifetime under 1 s or not whole, a ceiling under 1 s away, and a bad clock", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);
    const request = playIssue;
    const second = Math.floor(request.now / 1000) * 1000;

    const refused: ReadonlyArray<readonly [PersonalTicketRequest, string]> = [
      [{ ...request, lifetimeMs: 999 }, "lifetime"],
      [{ ...request, lifetimeMs: 1000.5 }, "lifetime"],
      [{ ...request, lifetimeMs: Number.NaN }, "lifetime"],
      [{ ...request, notAfter: request.now + 999 }, "ends_too_soon"],
      [{ ...request, now: second + 1, notAfter: second + 1500 }, "ends_too_soon"],
      [{ ...request, notAfter: Number.NaN }, "ends_too_soon"],
    ];

    const problems = await Promise.all(
      refused.map(async ([each]) => {
        const issued = await ring.issuePersonal(each);

        return issued.ok ? "issued" : issued.error.problem;
      }),
    );

    expect(problems).toEqual(refused.map(([, problem]) => problem));

    await Promise.all(
      [
        { ...request, now: Number.NaN },
        { ...request, now: 10 ** 14 + 1 },
      ].map((each) => expect(ring.issuePersonal(each)).rejects.toBeInstanceOf(RangeError)),
    );

    await expect(ring.admit(playRequest(playVector.ticket), Number.NaN)).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it("admits a 1 s ticket for a full second when it is issued late in a second", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);
    const now = Math.floor(playIssue.now / 1000) * 1000 + 999;
    const issued = await personalOf(ring, { ...playIssue, now, lifetimeMs: 1000 });

    expect(issued.expiresAt - now).toBeGreaterThanOrEqual(PERSONAL_TICKET_MIN_MS);
    expect(await reasonOf(ring, playRequest(issued.ticket), now + 999)).toBe("admitted");
  });

  it("issues tickets that still parse at the latest issue time", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);
    const now = 10 ** 14;
    const personal = await personalOf(ring, { ...playIssue, now });

    const shareable = await ring.issueShareable({
      resource: { kind: "artwork", id: "latest" },
      now,
    });

    const artworkRoute: TicketRoute = {
      purposes: ["image"],
      resource: { kind: "artwork", id: "latest" },
    };

    expect(await reasonOf(ring, playRequest(personal.ticket), now)).toBe("admitted");
    expect(
      await reasonOf(
        ring,
        { ticket: shareable.ticket, route: artworkRoute, readSession: live },
        now,
      ),
    ).toBe("admitted");
  });
});

describe("the clock", () => {
  it("allows a minute of skew before issue and none at expiry", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);

    await fc.assert(
      fc.asyncProperty(personalRequests, async (request) => {
        const issued = await personalOf(ring, request);
        const issuedAt = Math.floor(request.now / 1000) * 1000;

        const at = (now: number) =>
          reasonOf(
            ring,
            { ticket: issued.ticket, route: routeFor(request), readSession: live },
            now,
          );

        expect(await at(issuedAt - TICKET_CLOCK_SKEW_MS)).toBe("admitted");
        expect(await at(issuedAt - TICKET_CLOCK_SKEW_MS - 1)).toBe("not_yet_valid");
        expect(await at(issued.expiresAt - 1)).toBe("admitted");
        expect(await at(issued.expiresAt)).toBe("expired");
      }),
    );
  });
});

describe("the session reader", () => {
  it("refuses a personal ticket whose session ended or cannot be read", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);

    const readers: ReadonlyArray<readonly [SessionReader, TicketRefusalReason | "admitted"]> = [
      [live, "admitted"],
      [answering("ended"), "session_ended"],
      [answering("unavailable"), "session_unavailable"],
      [() => Promise.reject(new Error("watch lost")), "session_unavailable"],
      [
        () => {
          throw new Error("watch lost");
        },
        "session_unavailable",
      ],
    ];

    const answers = await Promise.all(
      readers.map(([reader]) =>
        reasonOf(ring, playRequest(playVector.ticket, reader), playVector.now),
      ),
    );

    expect(answers).toEqual(readers.map(([, expected]) => expected));
  });

  it("reads the session a personal ticket names, and never for a shareable one", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.k1);
    const read: Array<SessionPrincipal> = [];

    const recording: SessionReader = (principal) => {
      read.push(principal);

      return Promise.resolve("live");
    };

    await ring.admit(
      { ticket: artworkVector.ticket, route: artworkVector.route, readSession: recording },
      artworkVector.now,
    );

    expect(read).toEqual([]);

    await ring.admit(playRequest(playVector.ticket, recording), playVector.now);

    expect(read).toEqual([playIssue.principal]);
  });
});

describe("continuing an admitted stream", () => {
  it("continues the same ticket after it expired while its session is live", async () => {
    const admission = await admitVector(playVector, live);
    const continued = await admission.continue(playVector.ticket);

    expect(continued.ok && continued.value).toEqual(admission.claims);
    expect(Date.now()).toBeGreaterThan(admission.claims.expiresAt);
  });

  it("refuses another ticket, a download admission, and an ended session", async () => {
    let state: SessionState = "live";
    const admission = await admitVector(playVector, () => Promise.resolve(state));
    const download = await admitVector(downloadVector, live);

    const reasonOfContinue = async (continued: ReturnType<typeof admission.continue>) => {
      const answer = await continued;

      return answer.ok ? "continued" : answer.error.reason;
    };

    expect(await reasonOfContinue(admission.continue(downloadVector.ticket))).toBe("other_ticket");
    expect(await reasonOfContinue(admission.continue(playVector.ticket.repeat(10_000)))).toBe(
      "other_ticket",
    );
    expect(await reasonOfContinue(download.continue(downloadVector.ticket))).toBe("wrong_purpose");

    state = "ended";

    expect(await reasonOfContinue(admission.continue(playVector.ticket))).toBe("session_ended");

    state = "unavailable";

    expect(await reasonOfContinue(admission.continue(playVector.ticket))).toBe(
      "session_unavailable",
    );
  });

  it("continues after the key that signed it leaves the ring", async () => {
    const admission = await admitVector(playVector, live);
    const withoutIt = await ringOf(TICKET_TEST_KEYS.k2);

    expect(await reasonOf(withoutIt, playRequest(playVector.ticket), playVector.now)).toBe(
      "unknown_key",
    );
    expect((await admission.continue(playVector.ticket)).ok).toBe(true);
  });
});

const [key, otherKey] = keyTexts;

const aliasedKey = `${key.slice(0, -1)}${base64UrlAlphabet[base64UrlAlphabet.indexOf(key.slice(-1)) ^ 1] ?? ""}`;

const keyProblems: ReadonlyArray<readonly [string, TicketKeysProblem, number | null]> = [
  ["", "missing", null],
  ["k1", "entry_shape", 1],
  [`k1:${key}:x`, "entry_shape", 1],
  [`k1:${key},`, "entry_shape", 2],
  [`k1:${key}, k2:${otherKey}`, "key_id", 2],
  [`K1:${key}`, "key_id", 1],
  [`${"k".repeat(17)}:${key}`, "key_id", 1],
  [`k1:${key.slice(1)}`, "key_bytes", 1],
  [`k1:${key}A`, "key_bytes", 1],
  [`k1:${aliasedKey}`, "key_bytes", 1],
  [`k1:${key.replace("A", "+")}`, "key_bytes", 1],
  [`k1:${key}=`, "key_bytes", 1],
  [`k1:${key},k1:${otherKey}`, "duplicate_key_id", 2],
  [Array.from({ length: 9 }, (_, index) => `k${index}:${key}`).join(","), "too_many_keys", null],
];

describe("the key setting", () => {
  it("signs with the first entry and verifies with every entry", async () => {
    const ring = await ringOf(TICKET_TEST_KEYS.rotated);

    expect(ring.signingKeyId).toBe("k2");
    expect(ring.keyIds).toEqual(["k2", "k1"]);
  });

  it.each(keyProblems)("reads %j as %s in entry %s", async (text, problem, entry) => {
    const loaded = await loadTicketKeyRing(text);

    expect(loaded.ok ? "loaded" : [loaded.error.problem, loaded.error.entry]).toEqual([
      problem,
      entry,
    ]);

    for (const each of loaded.ok ? [] : shown(loaded.error)) {
      expect(each).not.toContain(key);
      expect(each).not.toContain(otherKey);
    }
  });

  it("loads unique entries", async () => {
    expect((await loadTicketKeyRing(`k1:${key},k2:${otherKey}`)).ok).toBe(true);
  });

  it("rotates without refusing a ticket before its keys retire", async () => {
    const k1 = await ringOf(TICKET_TEST_KEYS.k1);
    const added = await ringOf(`${TICKET_TEST_KEYS.k1},${TICKET_TEST_KEYS.k2}`);
    const promoted = await ringOf(TICKET_TEST_KEYS.rotated);
    const retired = await ringOf(TICKET_TEST_KEYS.k2);
    const request = playIssue;
    const oldTicket = (await personalOf(k1, request)).ticket;
    const newTicket = (await personalOf(promoted, request)).ticket;

    expect((await personalOf(added, request)).ticket).toBe(oldTicket);
    expect(await reasonOf(added, playRequest(newTicket), playVector.now)).toBe("admitted");
    expect(await reasonOf(promoted, playRequest(oldTicket), playVector.now)).toBe("admitted");
    expect(await reasonOf(retired, playRequest(oldTicket), playVector.now)).toBe("unknown_key");
    expect(await reasonOf(retired, playRequest(newTicket), playVector.now)).toBe("admitted");
  });
});

describe("secrecy", () => {
  it.each(TICKET_TEST_VECTORS)(
    "puts no ticket or key text in the answer or the ring for $name",
    async (vector) => {
      const ring = await ringOf(vector.keys);

      const admitted = await ring.admit(
        { ticket: vector.ticket, route: vector.route, readSession: answering(vector.session) },
        vector.now,
      );

      for (const text of [
        ...shown(admitted.ok ? admitted.value : admitted.error),
        ...shown(ring),
      ]) {
        expect(text).not.toContain(vector.ticket);
        expect(text).not.toContain(macOf(vector.ticket));
        expect(text).not.toContain(key);
        expect(text).not.toContain(otherKey);
      }
    },
  );

  it("keeps ticket.ts free of imports, so Convex and the server load the same file", () => {
    const source = readFileSync(new URL("ticket.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/^\s*import[\s{*]/mu);
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toMatch(/\brequire\s*\(/u);
    expect(source).not.toMatch(/^\s*export\s[^\n]*\sfrom\s/mu);
  });
});
