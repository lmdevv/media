import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { MediaFileId } from "@media/contracts/ids";

import {
  capabilityOf,
  empty,
  Evidence,
  exclude,
  forget,
  type Inventory,
  probeable,
  type ProbeOutcome,
  quarantine,
  quarantinedSince,
  record,
  snapshot,
  sourceScope,
} from "./capability-inventory.ts";
import { capabilityKey, ImplId } from "./video-ops.ts";

const TONE_MAP = capabilityKey(ImplId("tonemap.qsv"), "pq");

const DECODE = capabilityKey(ImplId("decode.qsv"), "h264/yuvj420p");

const FILM = sourceScope(MediaFileId.make("film"), 1000, 1, 0);

const OTHER = sourceScope(MediaFileId.make("other"), 1000, 1, 0);

const probe = (outcome: ProbeOutcome, at = 0, input: "generated" | "source" = "generated") =>
  Evidence.Probe({ at, outcome, input, detail: "", millis: 150 });

const recorded = (inventory: Inventory, key = TONE_MAP, outcome: ProbeOutcome = "passed") =>
  record(inventory, key, probe(outcome), capabilityOf(inventory, key).epoch);

const verifiedIn = (inventory: Inventory, at: number, scope = FILM) =>
  snapshot(inventory, scope, at, [], new Set()).verified;

describe("record", () => {
  it("verifies on a passed probe, refuses on a rejection, and keeps unknown when nothing was shown", () => {
    assert.strictEqual(capabilityOf(recorded(empty), TONE_MAP).status, "verified");
    assert.strictEqual(
      capabilityOf(recorded(empty, TONE_MAP, "rejected"), TONE_MAP).status,
      "unsupported",
    );

    const timedOut = recorded(empty, TONE_MAP, "inconclusive");

    assert.strictEqual(capabilityOf(timedOut, TONE_MAP).status, "unknown");
    assert.isFalse(probeable(timedOut, TONE_MAP, 1000));
    assert.isTrue(probeable(timedOut, TONE_MAP, 30_000));
  });

  it("proves absence from a listing, and presence only for a key nothing contradicted", () => {
    const absent = record(
      empty,
      TONE_MAP,
      Evidence.Build({ at: 0, feature: "filter:vpp_qsv", present: false }),
      0,
    );

    assert.strictEqual(capabilityOf(absent, TONE_MAP).status, "unsupported");

    const refused = record(
      recorded(empty, TONE_MAP, "rejected"),
      TONE_MAP,
      Evidence.Build({ at: 0, feature: "filter:vpp_qsv", present: true }),
      0,
    );

    assert.strictEqual(capabilityOf(refused, TONE_MAP).status, "unsupported");
  });

  it("drops a probe that finishes after a quarantine it started before", () => {
    const started = capabilityOf(empty, TONE_MAP).epoch;
    const quarantined = quarantine(recorded(empty), TONE_MAP, 0);
    const late = record(quarantined, TONE_MAP, probe("passed", 10), started);

    assert.strictEqual(late, quarantined);
    assert.isFalse(verifiedIn(late, 10).has(TONE_MAP));
  });

  it.prop(
    "keeps a real source's evidence to that source",
    { outcomes: Schema.Array(Schema.Literals(["passed", "rejected", "inconclusive"])) },
    ({ outcomes }) => {
      const shared = recorded(empty, DECODE, "rejected");

      const after = outcomes.reduce(
        (inventory, outcome, at) =>
          record(
            inventory,
            DECODE,
            probe(outcome, at, "source"),
            capabilityOf(inventory, DECODE).epoch,
            FILM,
          ),
        shared,
      );

      assert.strictEqual(capabilityOf(after, DECODE).status, "unsupported");
      assert.isFalse(verifiedIn(after, 0, OTHER).has(DECODE));
      assert.strictEqual(
        verifiedIn(after, 0, FILM).has(DECODE),
        capabilityOf(after, DECODE, FILM).status === "verified",
      );
    },
  );
});

describe("quarantine", () => {
  it("sets a key aside for 15 minutes, then 2 hours, then until a restart", () => {
    const first = quarantine(recorded(empty), TONE_MAP, 0);

    assert.isFalse(verifiedIn(first, 0).has(TONE_MAP));
    assert.isFalse(probeable(first, TONE_MAP, 15 * 60_000 - 1));
    assert.isTrue(probeable(first, TONE_MAP, 15 * 60_000));
    assert.strictEqual(capabilityOf(first, TONE_MAP).status, "unknown");

    const second = quarantine(recorded(first), TONE_MAP, 15 * 60_000);

    assert.isFalse(probeable(second, TONE_MAP, 15 * 60_000 + 2 * 3_600_000 - 1));
    assert.isTrue(probeable(second, TONE_MAP, 15 * 60_000 + 2 * 3_600_000));

    const third = quarantine(recorded(second), TONE_MAP, 3 * 3_600_000);

    assert.isFalse(probeable(third, TONE_MAP, Number.MAX_SAFE_INTEGER));
    assert.deepStrictEqual(quarantinedSince(third, 3 * 3_600_000), [TONE_MAP]);
  });
});

describe("snapshot", () => {
  it("excludes a source's rows only for that source, and only until they expire", () => {
    const excluded = exclude(recorded(empty), FILM, [ImplId("tonemap.qsv")], 1000);

    assert.isTrue(snapshot(excluded, FILM, 999, [], new Set()).excluded.has(ImplId("tonemap.qsv")));
    assert.isFalse(
      snapshot(excluded, FILM, 1000, [], new Set()).excluded.has(ImplId("tonemap.qsv")),
    );
    assert.isFalse(snapshot(excluded, OTHER, 0, [], new Set()).excluded.has(ImplId("tonemap.qsv")));
  });

  it("forgets what a changed device knew, and moves its epoch on", () => {
    const known = recorded(recorded(empty), DECODE);
    const before = capabilityOf(known, TONE_MAP).epoch;
    const changed = forget(known, (key) => key === TONE_MAP);

    assert.strictEqual(capabilityOf(changed, TONE_MAP).status, "unknown");
    assert.strictEqual(capabilityOf(changed, TONE_MAP).epoch, before + 1);
    assert.strictEqual(capabilityOf(changed, DECODE).status, "verified");
  });
});
