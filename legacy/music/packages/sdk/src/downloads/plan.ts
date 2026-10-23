/**
 * What a device does to hold what its downloads mean now. Pure: `DownloadSync` feeds it the
 * server's pins and manifests and the vault's rows, applies the steps, and plans again. Planning
 * after any prefix of the steps was applied yields the rest, so a crash at any point converges.
 *
 * Absence of data is not absence of a thing: before the server lists the pins, no pin is
 * forgotten, and a pin whose manifest hasn't arrived keeps every song it held and fetches none.
 */
import type { DownloadPinId, TrackId } from "@music/commands/ids";
import type {
  DownloadManifest,
  DownloadPin,
  DownloadTarget,
  ManifestEntry,
  ManifestEntryState,
  OfflineTrack,
  StreamProfile,
} from "@music/commands/models";
import { Data, Equal, Option, Struct } from "effect";

/** A song this device holds: one file of one revision of the server's file, in one profile. */
export interface StoredCopy {
  readonly track: OfflineTrack;
  /** The `fileRevision` of the server file the copy was made from. */
  readonly rev: string;
  readonly profile: StreamProfile;
  /** The file, relative to the vault. */
  readonly file: string;
  readonly bytes: number;
  readonly artHash: string | null;
}

/** One song of a pin, as its last known manifest listed it. */
export interface StoredMember {
  readonly trackId: TrackId;
  readonly state: ManifestEntryState;
}

/** A pin as this device last knew it. */
export interface StoredPin {
  readonly pin: DownloadPin;
  /** Its songs in order, from its last known manifest: what it keeps while no manifest is known. */
  readonly members: ReadonlyArray<StoredMember>;
}

/** A cover this device holds, by its content hash. */
export interface StoredArt {
  readonly hash: string;
  /** The file, relative to the vault. */
  readonly file: string;
  readonly bytes: number;
}

/** What the vault holds. */
export interface VaultView {
  readonly copies: ReadonlyMap<TrackId, StoredCopy>;
  readonly pins: ReadonlyMap<DownloadPinId, StoredPin>;
  readonly art: ReadonlyMap<string, StoredArt>;
}

/** What the server wants this device to hold, as far as the device has heard. */
export interface Desired {
  /** The device's pins, or none until the server first answered. */
  readonly pins: Option.Option<ReadonlyArray<DownloadPin>>;
  /** The manifests that arrived. A pin without one keeps what it held and fetches nothing. */
  readonly manifests: ReadonlyMap<DownloadPinId, DownloadManifest>;
  /** `targetKey`s of downloads this device is removing, ignored while the server still lists them. */
  readonly removing: ReadonlySet<string>;
}

/** The device's choices the server doesn't make. */
export interface SyncPolicy {
  /** The profile a new copy of `track` is fetched in: the download quality setting. */
  readonly profileFor: (track: OfflineTrack) => StreamProfile;
}

/** One step toward what the server wants, applied in order. */
export type SyncStep = Data.TaggedEnum<{
  /** Remember a pin and its songs (new, or its manifest changed). */
  SavePin: { readonly pin: StoredPin };
  /** Forget a pin the server no longer lists, or one this device is removing. */
  ForgetPin: { readonly pinId: DownloadPinId };
  /**
   * Fetch a song in `profile`: one this device doesn't hold, or a new revision of `replaces`,
   * whose file goes once the new one is in.
   */
  Fetch: {
    readonly entry: ManifestEntry;
    readonly profile: StreamProfile;
    readonly replaces: StoredCopy | null;
  };
  /** Same file, newer details (title, album, cover): rewrite the row as `copy`. */
  Refresh: { readonly copy: StoredCopy };
  /** Delete a song no pin keeps. */
  Drop: { readonly copy: StoredCopy };
  /** Fetch a cover some kept song or pin shows. */
  FetchArt: { readonly hash: string; readonly url: string };
  /** Delete a cover nothing shows. */
  DropArt: { readonly art: StoredArt };
}>;

/** Constructors and matchers for `SyncStep`. */
export const SyncStep = Data.taggedEnum<SyncStep>();

/** A download's song, album, or playlist as one string, for sets and maps. */
export const targetKey = (target: DownloadTarget): string => `${target.kind}:${target.id}`;

/**
 * Whether two versions of a song's details match, leaving out the cover's URL: its signature
 * rotates weekly, while `artHash` says whether the cover itself changed.
 */
const sameDetails = (left: OfflineTrack, right: OfflineTrack): boolean =>
  Equal.equals(Struct.omit(left, ["artUrl"]), Struct.omit(right, ["artUrl"]));

/** The members a manifest gives its pin. */
const membersOf = (manifest: DownloadManifest): ReadonlyArray<StoredMember> =>
  manifest.entries.map((entry) => ({ trackId: entry.track.id, state: entry.state }));

/**
 * The pins this device keeps now, minus those it is removing: the server's list once it
 * answered, else the vault's.
 */
const keptPins = (desired: Desired, vault: VaultView): ReadonlyArray<DownloadPin> => {
  const listed = Option.getOrElse(desired.pins, () =>
    Array.from(vault.pins.values(), (stored) => stored.pin),
  );

  return listed.filter((pin) => !desired.removing.has(targetKey(pin.target)));
};

/** Whether a stored pin goes: the server stopped listing it, or this device is removing it. */
const forgotten = (desired: Desired, stored: StoredPin): boolean =>
  desired.removing.has(targetKey(stored.pin.target)) ||
  Option.match(desired.pins, {
    onNone: () => false,
    onSome: (pins) => !pins.some((pin) => pin.id === stored.pin.id),
  });

/**
 * The steps that bring `vault` in line with `desired`. Pins come first, then deletions (to free
 * space), then refreshes, then fetches in pin and manifest order, then covers.
 */
export const planSync = (
  desired: Desired,
  vault: VaultView,
  policy: SyncPolicy,
): ReadonlyArray<SyncStep> => {
  const pins = keptPins(desired, vault);
  // Songs to hold at a revision, and songs whose copy stays whatever its revision.
  const wanted = new Map<TrackId, ManifestEntry>();
  const kept = new Set<TrackId>();
  // The newest details known for each kept song.
  const details = new Map<TrackId, ManifestEntry>();
  const covers = new Map<string, string | null>();

  // A cover known from a held copy only has no URL to fetch it from; a manifest's adds one.
  const cover = (hash: string | null, url: string | null): void => {
    if (hash !== null && (covers.get(hash) ?? null) === null) covers.set(hash, url);
  };

  const pinSteps: Array<SyncStep> = [];

  for (const [pinId, stored] of vault.pins) {
    if (forgotten(desired, stored)) pinSteps.push(SyncStep.ForgetPin({ pinId }));
  }

  for (const pin of pins) {
    const manifest = desired.manifests.get(pin.id);

    if (manifest === undefined) {
      for (const member of vault.pins.get(pin.id)?.members ?? []) kept.add(member.trackId);

      if (pin.available) cover(pin.artHash, pin.artUrl);
      continue;
    }

    for (const entry of manifest.entries) {
      const trackId = entry.track.id;
      kept.add(trackId);

      if (entry.state === "fetchable" && !wanted.has(trackId)) wanted.set(trackId, entry);

      if (!details.has(trackId)) details.set(trackId, entry);
    }

    if (manifest.pin.available) cover(manifest.pin.artHash, manifest.pin.artUrl);
    const next: StoredPin = { pin: manifest.pin, members: membersOf(manifest) };

    if (!Equal.equals(vault.pins.get(pin.id), next)) pinSteps.push(SyncStep.SavePin({ pin: next }));
  }

  const drops: Array<SyncStep> = [];
  const refreshes: Array<SyncStep> = [];
  const fetches: Array<SyncStep> = [];

  for (const [trackId, copy] of vault.copies) {
    if (!kept.has(trackId)) {
      drops.push(SyncStep.Drop({ copy }));
      continue;
    }

    const entry = wanted.get(trackId) ?? details.get(trackId);

    // Kept by a pin whose manifest hasn't arrived: as it is, cover included.
    if (entry === undefined) {
      cover(copy.artHash, null);
      continue;
    }

    // A new revision replaces the copy, details and cover included.
    if (wanted.has(trackId) && entry.rev !== copy.rev) continue;

    cover(entry.artHash, entry.track.artUrl);

    if (!sameDetails(entry.track, copy.track) || entry.artHash !== copy.artHash) {
      refreshes.push(
        SyncStep.Refresh({ copy: { ...copy, track: entry.track, artHash: entry.artHash } }),
      );
    }
  }

  for (const [trackId, entry] of wanted) {
    const held = vault.copies.get(trackId);
    cover(entry.artHash, entry.track.artUrl);

    if (held === undefined || held.rev !== entry.rev) {
      fetches.push(
        SyncStep.Fetch({ entry, profile: policy.profileFor(entry.track), replaces: held ?? null }),
      );
    }
  }

  const art: Array<SyncStep> = [];

  for (const [hash, url] of covers) {
    if (url !== null && !vault.art.has(hash)) art.push(SyncStep.FetchArt({ hash, url }));
  }

  for (const [hash, stored] of vault.art) {
    if (!covers.has(hash)) art.push(SyncStep.DropArt({ art: stored }));
  }

  return [...pinSteps, ...drops, ...refreshes, ...fetches, ...art];
};
