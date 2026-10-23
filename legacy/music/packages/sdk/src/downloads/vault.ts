/**
 * The vault: where a device keeps its downloads, as rows (songs, pins, covers) and files. Each
 * platform implements `VaultStore`; `DownloadSync` is its one writer.
 */
import type { DownloadPinId, TrackId } from "@music/commands/ids";
import type { DownloadTarget, StreamProfile } from "@music/commands/models";
import { Data } from "effect";

import type { StoredArt, StoredCopy, StoredPin, VaultView } from "./plan";

/** Everything the vault holds: what the planner reads, and the removals still to confirm. */
export interface VaultRows extends VaultView {
  /**
   * Downloads this device removed while the server still listed them, by `targetKey`. Kept
   * across restarts and sent to the server again at each start, so a removal made offline isn't
   * undone by the next `downloads.list`.
   */
  readonly removals: ReadonlyMap<string, DownloadTarget>;
}

/** One change to the vault's rows, applied in one transaction. */
export type VaultChange = Data.TaggedEnum<{
  PutPin: { readonly pin: StoredPin };
  DeletePin: { readonly pinId: DownloadPinId };
  /** Adds a song's copy, or replaces the row of the copy it held. */
  PutCopy: { readonly copy: StoredCopy };
  /**
   * Rewrites a copy's details while its row still names the same file. A row deleted or replaced
   * meanwhile stays as it is, so new details never bring back a copy whose file is gone.
   */
  UpdateCopy: { readonly copy: StoredCopy };
  /** Deletes a song's row while it still names `file`; a newer copy's row stays. */
  DeleteCopy: { readonly trackId: TrackId; readonly file: string };
  PutArt: { readonly art: StoredArt };
  DeleteArt: { readonly hash: string };
  PutRemoval: { readonly key: string; readonly target: DownloadTarget };
  DeleteRemoval: { readonly key: string };
}>;

/** Constructors and matchers for `VaultChange`. */
export const VaultChange = Data.taggedEnum<VaultChange>();

/** A device's durable store for its downloads. Rows reach `DownloadSync` parsed. */
export interface VaultStore {
  /** Every row. */
  readonly load: () => Promise<VaultRows>;
  /** Applies one change in one transaction. */
  readonly commit: (change: VaultChange) => Promise<void>;
  /** Every file in the vault, relative to it, for the sweep at start. */
  readonly files: () => Promise<ReadonlyArray<string>>;
  /** The URI of a vault file, to write or play it. */
  readonly uri: (file: string) => string;
  /** Deletes a vault file; one that isn't there is fine. */
  readonly remove: (file: string) => Promise<void>;
  /** The size of a vault file in bytes, or null when it isn't there. */
  readonly size: (file: string) => Promise<number | null>;
  /** Free space on the device, or null when the platform can't tell. */
  readonly freeBytes: () => number | null;
}

/** The view after `change`: what `DownloadSync` keeps in memory once the change committed. */
export const applyChange = (view: VaultRows, change: VaultChange): VaultRows =>
  VaultChange.$match(change, {
    PutPin: ({ pin }) => ({ ...view, pins: new Map(view.pins).set(pin.pin.id, pin) }),
    DeletePin: ({ pinId }) => {
      const pins = new Map(view.pins);
      pins.delete(pinId);

      return { ...view, pins };
    },
    PutCopy: ({ copy }) => ({ ...view, copies: new Map(view.copies).set(copy.track.id, copy) }),
    UpdateCopy: ({ copy }) =>
      view.copies.get(copy.track.id)?.file === copy.file
        ? { ...view, copies: new Map(view.copies).set(copy.track.id, copy) }
        : view,
    DeleteCopy: ({ trackId, file }) => {
      if (view.copies.get(trackId)?.file !== file) return view;
      const copies = new Map(view.copies);
      copies.delete(trackId);

      return { ...view, copies };
    },
    PutArt: ({ art }) => ({ ...view, art: new Map(view.art).set(art.hash, art) }),
    DeleteArt: ({ hash }) => {
      const art = new Map(view.art);
      art.delete(hash);

      return { ...view, art };
    },
    PutRemoval: ({ key, target }) => ({
      ...view,
      removals: new Map(view.removals).set(key, target),
    }),
    DeleteRemoval: ({ key }) => {
      const removals = new Map(view.removals);
      removals.delete(key);

      return { ...view, removals };
    },
  });

/** Nothing held: a new vault. */
export const emptyVault: VaultRows = {
  copies: new Map(),
  pins: new Map(),
  art: new Map(),
  removals: new Map(),
};

/**
 * The file extension the platform's player needs for each type the media service sends. A
 * player opening a local file goes by its name, not its bytes.
 */
const EXTENSIONS = new Map([
  ["audio/mp4", "m4a"],
  ["audio/flac", "flac"],
  ["audio/mpeg", "mp3"],
  ["audio/aac", "aac"],
  ["audio/wav", "wav"],
  ["audio/aiff", "aiff"],
]);

/** What the server's IDs, revisions, and hashes look like; anything else never names a file. */
const NAME_PART = /^[\w-]+$/u;

/**
 * The vault file for a copy of a song, or null for a type the vault doesn't keep. The name holds
 * the revision and profile, so a new copy never overwrites the file of one that may be playing.
 */
export const audioFile = (
  trackId: TrackId,
  rev: string,
  profile: StreamProfile,
  contentType: string | null,
): string | null => {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = EXTENSIONS.get(mime);

  if (extension === undefined || !NAME_PART.test(trackId) || !NAME_PART.test(rev)) return null;

  return `audio/${trackId}.${rev}.${profile}.${extension}`;
};

/** The vault file for a cover, by its content hash, or null for a hash that can't name one. */
export const artFile = (hash: string): string | null =>
  NAME_PART.test(hash) ? `art/${hash}` : null;
