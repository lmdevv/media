import { AlbumId, ArtistId, DeviceId, DownloadPinId, TrackId } from "@music/commands/ids";
import type {
  DownloadManifest,
  DownloadPin,
  ManifestEntry,
  ManifestEntryState,
  OfflineTrack,
  StreamProfile,
} from "@music/commands/models";
import * as fc from "fast-check";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { planSync, SyncStep, targetKey } from "./plan";
import type { Desired, StoredCopy, StoredPin, SyncPolicy, VaultView } from "./plan";

const TRACKS = ["t1", "t2", "t3", "t4", "t5"].map((id) => TrackId.make(id));

const PINS = ["p1", "p2", "p3"].map((id) => DownloadPinId.make(id));

const track = (id: TrackId, title = "Song", artUrl: string | null = null): OfflineTrack => ({
  id,
  title,
  artist: "Massive Attack",
  artistId: ArtistId.make("artist"),
  album: "Blue Lines",
  albumId: AlbumId.make("album"),
  trackNumber: 1,
  discNumber: 1,
  durationMs: 1000,
  codec: "FLAC",
  lossless: true,
  bitrate: null,
  sampleRate: null,
  bitDepth: null,
  artUrl,
});

const pin = (id: DownloadPinId, available = true): DownloadPin =>
  available
    ? {
        id,
        deviceId: DeviceId.make("phone"),
        target: { kind: "album", id: AlbumId.make(`album-${id}`) },
        createdAt: 1,
        available: true,
        title: `Album ${id}`,
        subtitle: "Massive Attack",
        artUrl: `/media/art/${id}`,
        artHash: `cover-${id}`,
      }
    : {
        id,
        deviceId: DeviceId.make("phone"),
        target: { kind: "album", id: AlbumId.make(`album-${id}`) },
        createdAt: 1,
        available: false,
      };

const entry = (
  id: TrackId,
  rev: string,
  state: ManifestEntryState = "fetchable",
  title = "Song",
): ManifestEntry => ({ track: track(id, title), rev, artHash: null, state });

const manifest = (of: DownloadPin, entries: ReadonlyArray<ManifestEntry>): DownloadManifest => ({
  pin: of,
  entries: of.available ? entries : [],
});

const copy = (id: TrackId, rev: string, title = "Song"): StoredCopy => ({
  track: track(id, title),
  rev,
  profile: "aac-320",
  file: `audio/${id}.${rev}.m4a`,
  bytes: 10,
  artHash: null,
});

const storedPin = (of: DownloadPin, members: ReadonlyArray<ManifestEntry>): StoredPin => ({
  pin: of,
  members: members.map((member) => ({ trackId: member.track.id, state: member.state })),
});

const vaultOf = (
  copies: ReadonlyArray<StoredCopy>,
  pins: ReadonlyArray<StoredPin> = [],
): VaultView => ({
  copies: new Map(copies.map((held) => [held.track.id, held])),
  pins: new Map(pins.map((stored) => [stored.pin.id, stored])),
  art: new Map(),
});

const desiredOf = (
  pins: ReadonlyArray<DownloadPin> | null,
  manifests: ReadonlyArray<DownloadManifest>,
  removing: ReadonlyArray<DownloadPin> = [],
): Desired => ({
  pins: Option.fromNullishOr(pins),
  manifests: new Map(manifests.map((known) => [known.pin.id, known])),
  removing: new Set(removing.map((removed) => targetKey(removed.target))),
});

const policy: SyncPolicy = {
  profileFor: (song): StreamProfile => (song.lossless ? "original" : "aac-320"),
};

/** What `DownloadSync` makes of each step, as far as the plan can see. */
const apply = (vault: VaultView, step: SyncStep): VaultView => {
  const copies = new Map(vault.copies);
  const pins = new Map(vault.pins);
  const art = new Map(vault.art);

  SyncStep.$match(step, {
    SavePin: ({ pin: saved }) => pins.set(saved.pin.id, saved),
    ForgetPin: ({ pinId }) => pins.delete(pinId),
    Fetch: ({ entry: fetched, profile }) =>
      copies.set(fetched.track.id, {
        track: fetched.track,
        rev: fetched.rev,
        profile,
        file: `audio/${fetched.track.id}.${fetched.rev}.${profile}`,
        bytes: 10,
        artHash: fetched.artHash,
      }),
    Refresh: ({ copy: refreshed }) => copies.set(refreshed.track.id, refreshed),
    Drop: ({ copy: dropped }) => copies.delete(dropped.track.id),
    FetchArt: ({ hash }) => art.set(hash, { hash, file: `art/${hash}`, bytes: 1 }),
    DropArt: ({ art: dropped }) => art.delete(dropped.hash),
  });

  return { copies, pins, art };
};

/** The kinds of the steps that touch songs or pins, without covers. */
const songSteps = (steps: ReadonlyArray<SyncStep>): ReadonlyArray<string> =>
  steps.flatMap((step) =>
    SyncStep.$match(step, {
      SavePin: () => ["SavePin"],
      ForgetPin: () => ["ForgetPin"],
      Fetch: () => ["Fetch"],
      Refresh: () => ["Refresh"],
      Drop: () => ["Drop"],
      FetchArt: () => [],
      DropArt: () => [],
    }),
  );

describe("planSync", () => {
  it("fetches every fetchable song of a new download in its manifest's order", () => {
    const album = pin(DownloadPinId.make("p1"));
    const first = TrackId.make("t1");
    const second = TrackId.make("t2");

    const fetches = planSync(
      desiredOf([album], [manifest(album, [entry(second, "r1"), entry(first, "r1")])]),
      vaultOf([]),
      policy,
    ).filter(SyncStep.$is("Fetch"));

    expect(fetches.map((step) => step.entry.track.id)).toEqual([second, first]);
    expect(fetches.map((step) => step.profile)).toEqual(["original", "original"]);
  });

  it("replaces a copy whose file changed on the server, and only refreshes one whose details did", () => {
    const album = pin(DownloadPinId.make("p1"));
    const retagged = TrackId.make("t1");
    const renamed = TrackId.make("t2");
    const held = [copy(retagged, "r1"), copy(renamed, "r1")];

    const steps = planSync(
      desiredOf(
        [album],
        [manifest(album, [entry(retagged, "r2"), entry(renamed, "r1", "fetchable", "New title")])],
      ),
      vaultOf(held, [storedPin(album, [entry(retagged, "r2"), entry(renamed, "r1")])]),
      policy,
    );

    expect(steps).toContainEqual(
      SyncStep.Fetch({
        entry: entry(retagged, "r2"),
        profile: "original",
        replaces: held[0] ?? null,
      }),
    );

    expect(steps).toContainEqual(
      SyncStep.Refresh({ copy: { ...copy(renamed, "r1"), track: track(renamed, "New title") } }),
    );
  });

  it("leaves a copy alone when only its cover's signed URL rotated", () => {
    const album = pin(DownloadPinId.make("p1"));
    const song = TrackId.make("t1");

    const resigned: ManifestEntry = {
      track: track(song, "Song", "/media/art/x?sig=new"),
      rev: "r1",
      artHash: null,
      state: "fetchable",
    };

    const steps = planSync(
      desiredOf([album], [manifest(album, [resigned])]),
      vaultOf([copy(song, "r1")], [storedPin(album, [resigned])]),
      policy,
    );

    expect(songSteps(steps)).toEqual([]);
  });

  it("keeps a playlist song whose file went missing, and fetches nothing for it", () => {
    const playlist = pin(DownloadPinId.make("p1"));
    const gone = TrackId.make("t1");

    const steps = planSync(
      desiredOf([playlist], [manifest(playlist, [entry(gone, "r2", "missing")])]),
      vaultOf([copy(gone, "r1")], [storedPin(playlist, [entry(gone, "r1")])]),
      policy,
    );

    expect(songSteps(steps)).toEqual(["SavePin"]);
  });

  it("deletes what an unavailable download held", () => {
    const album = pin(DownloadPinId.make("p1"), false);
    const song = TrackId.make("t1");

    const steps = planSync(
      desiredOf([album], [manifest(album, [])]),
      vaultOf([copy(song, "r1")], [storedPin(pin(album.id), [entry(song, "r1")])]),
      policy,
    );

    expect(songSteps(steps)).toEqual(["SavePin", "Drop"]);
  });

  it("forgets nothing and deletes nothing before the server answers", () => {
    const album = pin(DownloadPinId.make("p1"));
    const song = TrackId.make("t1");

    const steps = planSync(
      desiredOf(null, []),
      vaultOf([copy(song, "r1")], [storedPin(album, [entry(song, "r1")])]),
      policy,
    );

    expect(songSteps(steps)).toEqual([]);
  });

  it("deletes a download this device removes before the server confirms it", () => {
    const album = pin(DownloadPinId.make("p1"));
    const song = TrackId.make("t1");

    const steps = planSync(
      desiredOf([album], [manifest(album, [entry(song, "r1")])], [album]),
      vaultOf([copy(song, "r1")], [storedPin(album, [entry(song, "r1")])]),
      policy,
    );

    expect(songSteps(steps)).toEqual(["ForgetPin", "Drop"]);
  });

  it("fetches a pin's cover and drops covers nothing shows", () => {
    const album = pin(DownloadPinId.make("p1"));

    const steps = planSync(
      desiredOf([album], [manifest(album, [])]),
      {
        ...vaultOf([], [storedPin(album, [])]),
        art: new Map([["stale", { hash: "stale", file: "art/stale", bytes: 1 }]]),
      },
      policy,
    );

    expect(steps).toEqual([
      SyncStep.FetchArt({ hash: "cover-p1", url: "/media/art/p1" }),
      SyncStep.DropArt({ art: { hash: "stale", file: "art/stale", bytes: 1 } }),
    ]);
  });
});

const arbitraryEntry = (id: TrackId): fc.Arbitrary<ManifestEntry> =>
  fc.record({
    track: fc.constantFrom("A", "B").map((title) => track(id, title)),
    rev: fc.constantFrom("r1", "r2"),
    artHash: fc.constantFrom(null, "h1", "h2"),
    state: fc.constantFrom<ManifestEntryState>("fetchable", "missing", "held"),
  });

const arbitraryEntries: fc.Arbitrary<ReadonlyArray<ManifestEntry>> = fc
  .subarray(TRACKS)
  .chain((ids) => fc.tuple(...ids.map(arbitraryEntry)));

const arbitraryPin = (id: DownloadPinId): fc.Arbitrary<DownloadPin> =>
  fc.boolean().map((available) => pin(id, available));

const arbitraryCopy = (id: TrackId): fc.Arbitrary<StoredCopy> =>
  fc.record({
    track: fc.constantFrom("A", "B").map((title) => track(id, title)),
    rev: fc.constantFrom("r1", "r2"),
    profile: fc.constantFrom<StreamProfile>("aac-320", "original"),
    file: fc.constant(`audio/${id}`),
    bytes: fc.nat(100),
    artHash: fc.constantFrom(null, "h1", "h2"),
  });

const arbitraryVault: fc.Arbitrary<VaultView> = fc
  .record({
    copies: fc.subarray(TRACKS).chain((ids) => fc.tuple(...ids.map(arbitraryCopy))),
    pins: fc
      .subarray(PINS)
      .chain((ids) =>
        fc.tuple(
          ...ids.map((id) =>
            fc
              .tuple(arbitraryPin(id), arbitraryEntries)
              .map(([of, members]) => storedPin(of, members)),
          ),
        ),
      ),
    art: fc.subarray(["h1", "h2", "cover-p1", "stale"]),
  })
  .map(({ copies, pins, art }) => {
    const { copies: held, pins: stored } = vaultOf(copies, pins);

    return {
      copies: held,
      pins: stored,
      art: new Map(art.map((hash) => [hash, { hash, file: `art/${hash}`, bytes: 1 }])),
    };
  });

const arbitraryDesired: fc.Arbitrary<Desired> = fc
  .record({
    pins: fc.option(fc.subarray(PINS).chain((ids) => fc.tuple(...ids.map(arbitraryPin)))),
    manifests: fc
      .subarray(PINS)
      .chain((ids) =>
        fc.tuple(
          ...ids.map((id) =>
            fc
              .tuple(arbitraryPin(id), arbitraryEntries)
              .map(([of, entries]) => manifest(of, entries)),
          ),
        ),
      ),
    removing: fc.subarray(PINS),
  })
  .map(({ pins, manifests, removing }) =>
    desiredOf(
      pins,
      manifests,
      removing.map((id) => pin(id)),
    ),
  );

const settle = (vault: VaultView, steps: ReadonlyArray<SyncStep>): VaultView =>
  steps.reduce(apply, vault);

describe("planSync properties", () => {
  it("has nothing left to do once its steps are applied", () => {
    fc.assert(
      fc.property(arbitraryDesired, arbitraryVault, (desired, vault) => {
        const steps = planSync(desired, vault, policy);

        expect(planSync(desired, settle(vault, steps), policy)).toEqual([]);
      }),
    );
  });

  it("plans the remaining steps after any prefix was applied, as after a crash", () => {
    fc.assert(
      fc.property(arbitraryDesired, arbitraryVault, fc.nat(), (desired, vault, cut) => {
        const steps = planSync(desired, vault, policy);
        const done = cut % (steps.length + 1);

        expect(planSync(desired, settle(vault, steps.slice(0, done)), policy)).toEqual(
          steps.slice(done),
        );
      }),
    );
  });

  it("never deletes a song a download keeps while its manifest is unknown", () => {
    fc.assert(
      fc.property(arbitraryDesired, arbitraryVault, (desired, vault) => {
        const unknown = [...vault.pins.values()].filter(
          (stored) =>
            !desired.manifests.has(stored.pin.id) &&
            !desired.removing.has(targetKey(stored.pin.target)) &&
            Option.match(desired.pins, {
              onNone: () => true,
              onSome: (pins) => pins.some((listed) => listed.id === stored.pin.id),
            }),
        );

        const protectedIds = new Set(
          unknown.flatMap((stored) => stored.members.map((member) => member.trackId)),
        );

        const dropped = planSync(desired, vault, policy)
          .filter(SyncStep.$is("Drop"))
          .map((step) => step.copy.track.id);

        expect(dropped.filter((id) => protectedIds.has(id))).toEqual([]);
      }),
    );
  });

  it("neither fetches nor deletes a song whose library is held", () => {
    fc.assert(
      fc.property(arbitraryDesired, arbitraryVault, (desired, vault) => {
        const entries = [...desired.manifests.values()]
          .filter((known) =>
            Option.match(desired.pins, {
              onNone: () => vault.pins.has(known.pin.id),
              onSome: (pins) => pins.some((listed) => listed.id === known.pin.id),
            }),
          )
          .filter((known) => !desired.removing.has(targetKey(known.pin.target)))
          .flatMap((known) => known.entries);

        const fetchable = new Set(
          entries.flatMap((known) => (known.state === "fetchable" ? [known.track.id] : [])),
        );

        const heldOnly = new Set(
          entries.flatMap((known) =>
            known.state === "held" && !fetchable.has(known.track.id) ? [known.track.id] : [],
          ),
        );

        const steps = planSync(desired, vault, policy);

        const touched = [
          ...steps.filter(SyncStep.$is("Fetch")).map((step) => step.entry.track.id),
          ...steps.filter(SyncStep.$is("Drop")).map((step) => step.copy.track.id),
        ];

        expect(touched.filter((id) => heldOnly.has(id))).toEqual([]);
      }),
    );
  });
});
