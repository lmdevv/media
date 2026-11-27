import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { MediaFileId } from "@media/contracts/ids";

import {
  capabilityOf,
  empty,
  Evidence,
  forget,
  type Inventory,
  notReproduced,
  probeable,
  type ProbeOutcome,
  quarantinedSince,
  record,
  reproduced,
  runsToVerify,
  snapshot,
  type SourceScope,
  sourceScope,
} from "./capability-inventory.ts";
import { capabilityKey, ImplId } from "./video-ops.ts";

const TONE_MAP = capabilityKey(ImplId("tonemap.qsv"), "pq");

const DECODE = capabilityKey(ImplId("decode.qsv"), "h264/yuvj420p");

const FILM = sourceScope(MediaFileId.make("film"), 1000, 1, 0);

const OTHER = sourceScope(MediaFileId.make("other"), 1000, 1, 0);

const DAY = 24 * 3_600_000;

const probe = (outcome: ProbeOutcome, at = 0, source?: SourceScope) =>
  Evidence.Probe({ at, outcome, source, detail: "", millis: 150 });

const recorded = (inventory: Inventory, key = TONE_MAP, outcome: ProbeOutcome = "passed") =>
  record(inventory, key, probe(outcome), capabilityOf(inventory, key).epoch);

/** A failure a generated clip reproduced at `at`, under the key's epoch now. */
const struck = (inventory: Inventory, key: typeof TONE_MAP, at: number) =>
  reproduced(inventory, key, probe("rejected", at), capabilityOf(inventory, key).epoch);

const verifiedIn = (inventory: Inventory, at: number, scope = FILM) =>
  snapshot(inventory, scope, at, [], new Set()).verified;

const excludedIn = (inventory: Inventory, at: number, scope = FILM) =>
  snapshot(inventory, scope, at, [], new Set()).excluded;

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

  it("sets a key aside on a probe that crashed, as on a reproduced failure, and keeps its evidence", () => {
    const crashedAt = (inventory: Inventory, at: number) =>
      record(inventory, TONE_MAP, probe("crashed", at), capabilityOf(inventory, TONE_MAP).epoch);

    const first = crashedAt(empty, 0);
    const known = capabilityOf(first, TONE_MAP);

    assert.strictEqual(known.status, "unknown");
    assert.deepStrictEqual(
      known.evidence.map((evidence) => (Evidence.$is("Probe")(evidence) ? evidence.outcome : "")),
      ["crashed"],
    );
    assert.isFalse(probeable(first, TONE_MAP, 15 * 60_000 - 1));
    assert.isTrue(probeable(first, TONE_MAP, 15 * 60_000));

    const second = crashedAt(first, 15 * 60_000);

    assert.isFalse(probeable(second, TONE_MAP, 15 * 60_000 + 2 * 3_600_000 - 1));
    assert.isTrue(probeable(second, TONE_MAP, 15 * 60_000 + 2 * 3_600_000));

    const third = crashedAt(second, 3 * 3_600_000);

    assert.isFalse(probeable(third, TONE_MAP, Number.MAX_SAFE_INTEGER));
    assert.isFalse(verifiedIn(third, Number.MAX_SAFE_INTEGER).has(TONE_MAP));
  });

  it("keeps a crashed probe of a real source to that source, which stays off the row for a day", () => {
    const shared = recorded(empty, DECODE);

    const crashed = record(
      shared,
      DECODE,
      probe("crashed", 0, FILM),
      capabilityOf(shared, DECODE).epoch,
    );

    assert.deepStrictEqual(crashed.capabilities, shared.capabilities);
    assert.isTrue(excludedIn(crashed, DAY - 1).has(ImplId("decode.qsv")));
    assert.isFalse(excludedIn(crashed, DAY).has(ImplId("decode.qsv")));
    assert.isFalse(excludedIn(crashed, 0, OTHER).has(ImplId("decode.qsv")));
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
    const quarantined = struck(recorded(empty), TONE_MAP, 0);
    const late = record(quarantined, TONE_MAP, probe("passed", 10), started);

    assert.strictEqual(late, quarantined);
    assert.isFalse(verifiedIn(late, 10).has(TONE_MAP));
  });

  it("drops a key's first proof when its device changed while it ran", () => {
    const started = capabilityOf(empty, DECODE).epoch;
    const changed = forget(empty, "qsv");
    const late = record(changed, DECODE, probe("passed", 10), started);

    assert.strictEqual(late, changed);
    assert.strictEqual(capabilityOf(late, DECODE).status, "unknown");

    // Another domain's keys keep their epochs.
    const cpu = capabilityKey(ImplId("encode.cpu.h264"), "8/crf");

    assert.strictEqual(capabilityOf(changed, cpu).epoch, capabilityOf(empty, cpu).epoch);
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
            probe(outcome, at, FILM),
            capabilityOf(inventory, DECODE).epoch,
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

describe("reproduced", () => {
  it("quarantines a key for 15 minutes, then 2 hours, then until a restart", () => {
    const first = struck(recorded(empty), TONE_MAP, 0);

    assert.isFalse(verifiedIn(first, 0).has(TONE_MAP));
    assert.isFalse(probeable(first, TONE_MAP, 15 * 60_000 - 1));
    assert.isTrue(probeable(first, TONE_MAP, 15 * 60_000));
    assert.strictEqual(capabilityOf(first, TONE_MAP).status, "unknown");

    const second = struck(recorded(first), TONE_MAP, 15 * 60_000);

    assert.isFalse(probeable(second, TONE_MAP, 15 * 60_000 + 2 * 3_600_000 - 1));
    assert.isTrue(probeable(second, TONE_MAP, 15 * 60_000 + 2 * 3_600_000));

    const third = struck(recorded(second), TONE_MAP, 3 * 3_600_000);

    assert.isFalse(probeable(third, TONE_MAP, Number.MAX_SAFE_INTEGER));
    assert.deepStrictEqual(quarantinedSince(third, 3 * 3_600_000), [TONE_MAP]);
  });

  it("asks a key with strikes for three times the clean runs per strike, after its quarantine too", () => {
    assert.strictEqual(runsToVerify(empty, TONE_MAP, 3), 3);

    const once = struck(recorded(empty), TONE_MAP, 0);

    assert.strictEqual(runsToVerify(once, TONE_MAP, 3), 9);
    assert.strictEqual(
      runsToVerify(recorded(once), TONE_MAP, 1),
      3,
      "a later pass keeps the strike",
    );

    const twice = struck(recorded(once), TONE_MAP, 15 * 60_000);

    assert.strictEqual(runsToVerify(twice, TONE_MAP, 3), 27);
    assert.strictEqual(runsToVerify(twice, DECODE, 3), 3, "strikes are the key's own");
  });

  it("keeps the probe that reproduced the failure as the quarantined key's newest evidence", () => {
    const verified = recorded(empty);

    const failedAgain = Evidence.Probe({
      at: 60_000,
      outcome: "rejected",
      source: undefined,
      detail: "[Parsed_vpp_qsv_0 @ 0x1] Invalid color_matrix.",
      millis: 140,
    });

    const after = reproduced(
      verified,
      TONE_MAP,
      failedAgain,
      capabilityOf(verified, TONE_MAP).epoch,
    );

    const known = capabilityOf(after, TONE_MAP);

    assert.deepStrictEqual(known.evidence, [
      failedAgain,
      ...capabilityOf(verified, TONE_MAP).evidence,
    ]);
    assert.strictEqual(known.status, "unknown");
    assert.deepStrictEqual(
      Option.map(known.quarantine, (q) => q.until),
      Option.some(60_000 + 15 * 60_000),
    );
  });

  it("takes one strike for diagnoses of one outage, overlapping or begun during the quarantine", () => {
    const verified = recorded(empty);
    const began = capabilityOf(verified, TONE_MAP).epoch;
    const once = reproduced(verified, TONE_MAP, probe("rejected", 0), began);
    const overlapping = reproduced(once, TONE_MAP, probe("rejected", 10), began);
    const during = struck(overlapping, TONE_MAP, 20);

    assert.strictEqual(overlapping, once);
    assert.strictEqual(during, once);
    assert.deepStrictEqual(
      Option.map(capabilityOf(during, TONE_MAP).quarantine, (q) => q.strikes),
      Option.some(1),
    );
  });

  it("drops the source's evidence for a quarantined key, so it is probed again afterwards", () => {
    const proven = record(empty, DECODE, probe("passed", 0, FILM), 0);

    assert.isTrue(verifiedIn(proven, 0).has(DECODE));
    const quarantined = struck(proven, DECODE, 0);
    const later = 15 * 60_000;

    assert.isFalse(verifiedIn(quarantined, later).has(DECODE));
    assert.isTrue(probeable(quarantined, DECODE, later, FILM));
  });

  it("keeps a failure reproduced on a real source to that source", () => {
    const shared = recorded(empty, DECODE);

    const after = reproduced(
      shared,
      DECODE,
      probe("rejected", 0, FILM),
      capabilityOf(shared, DECODE).epoch,
    );

    assert.deepStrictEqual(capabilityOf(after, DECODE), capabilityOf(shared, DECODE));
    assert.isTrue(excludedIn(after, DAY - 1).has(ImplId("decode.qsv")));
    assert.isFalse(excludedIn(after, DAY).has(ImplId("decode.qsv")));
    assert.isTrue(verifiedIn(after, 0, OTHER).has(DECODE));
    assert.isFalse(excludedIn(after, 0, OTHER).has(ImplId("decode.qsv")));
  });

  it.prop(
    "lets nothing a real source showed change what another file may use",
    {
      steps: Schema.Array(
        Schema.Struct({
          outcome: Schema.Literals(["passed", "rejected", "crashed", "inconclusive", "reproduced"]),
          key: Schema.Literals(["decode", "tonemap"]),
        }),
      ),
    },
    ({ steps }) => {
      const before = recorded(recorded(empty, DECODE));

      const after = steps.reduce((inventory, { outcome, key }, at) => {
        const chosen = key === "decode" ? DECODE : TONE_MAP;
        const epoch = capabilityOf(inventory, chosen).epoch;

        return outcome === "reproduced"
          ? reproduced(inventory, chosen, probe("rejected", at, FILM), epoch)
          : record(inventory, chosen, probe(outcome, at, FILM), epoch);
      }, before);

      assert.deepStrictEqual(after.capabilities, before.capabilities);
      assert.deepStrictEqual(
        snapshot(after, OTHER, 0, [], new Set()),
        snapshot(before, OTHER, 0, [], new Set()),
      );
    },
  );
});

describe("notReproduced", () => {
  it("keeps a source off a row for a day, and only that source", () => {
    const shared = recorded(empty);
    const excluded = notReproduced(shared, TONE_MAP, FILM, 0, capabilityOf(shared, TONE_MAP).epoch);

    assert.isTrue(excludedIn(excluded, DAY - 1).has(ImplId("tonemap.qsv")));
    assert.isFalse(excludedIn(excluded, DAY).has(ImplId("tonemap.qsv")));
    assert.isFalse(excludedIn(excluded, 0, OTHER).has(ImplId("tonemap.qsv")));
  });

  it("drops a verdict a quarantine overtook", () => {
    const shared = recorded(empty);
    const began = capabilityOf(shared, TONE_MAP).epoch;
    const quarantined = struck(shared, TONE_MAP, 0);

    assert.strictEqual(notReproduced(quarantined, TONE_MAP, FILM, 0, began), quarantined);
  });

  it("never keeps a file off a CPU row, whatever a probe of it showed", () => {
    const encodeCpu = capabilityKey(ImplId("encode.cpu.h264"), "8/crf");
    const decodeCpu = capabilityKey(ImplId("decode.cpu"), "h264/yuv420p");
    const shared = recorded(recorded(empty, encodeCpu), decodeCpu);
    const epochOf = (key: typeof encodeCpu) => capabilityOf(shared, key).epoch;

    const after = [
      notReproduced(shared, encodeCpu, FILM, 0, epochOf(encodeCpu)),
      reproduced(shared, encodeCpu, probe("rejected", 0, FILM), epochOf(encodeCpu)),
      record(shared, decodeCpu, probe("crashed", 0, FILM), epochOf(decodeCpu)),
    ];

    for (const inventory of after) {
      assert.isFalse(excludedIn(inventory, 0).has(ImplId("encode.cpu.h264")));
      assert.isFalse(excludedIn(inventory, 0).has(ImplId("decode.cpu")));
    }
  });
});

describe("forget", () => {
  it("forgets what a changed device knew, and moves its epochs on", () => {
    const known = recorded(recorded(empty), capabilityKey(ImplId("encode.cpu.h264"), "8/crf"));
    const before = capabilityOf(known, TONE_MAP).epoch;
    const changed = forget(known, "qsv");

    assert.strictEqual(capabilityOf(changed, TONE_MAP).status, "unknown");
    assert.isAbove(capabilityOf(changed, TONE_MAP).epoch, before);
    assert.strictEqual(
      capabilityOf(changed, capabilityKey(ImplId("encode.cpu.h264"), "8/crf")).status,
      "verified",
    );
  });
});
