/**
 * `DownloadSync` keeps one device's vault in line with its downloads: the one writer of the
 * vault. Hosts offer it what the server says (the pins, each pin's manifest, whether the server
 * answers); it plans, applies the cheap steps at once, and fetches up to two files at a time,
 * retrying failures with backoff. Screens read its snapshot.
 */
import type { DeviceId, DownloadPinId, TrackId } from "@music/commands/ids";
import type {
  DownloadManifest,
  DownloadPin,
  DownloadTarget,
  OfflineTrack,
  StreamProfile,
} from "@music/commands/models";
import type { Data } from "effect";
import { Option } from "effect";

import type { MusicClient } from "../client";
import { DownloadResult, fetchFinishedFile, FetchOutcome } from "./finished-file";
import type { Transfer } from "./finished-file";
import { planSync, SyncStep, targetKey } from "./plan";
import type { StoredArt, StoredCopy, StoredMember, SyncPolicy } from "./plan";
import { applyChange, artFile, audioFile, emptyVault, VaultChange } from "./vault";
import type { VaultRows, VaultStore } from "./vault";

/** Files fetched at once. Prepares on the server run one at a time anyway. */
const MAX_TRANSFERS = 2;

/** Fetching waits while the device has less free space than this. */
const MIN_FREE_BYTES = 1024 ** 3;

/** How often fetching checks again for free space while it waits for some. */
const SPACE_RECHECK_MS = 60_000;

/** The first wait after a failed fetch; each failure in a row doubles it. */
const FIRST_RETRY_MS = 10_000;

const MAX_RETRY_MS = 10 * 60_000;

/** The wait after a vault write failed (a full disk, say) before planning again. */
const VAULT_RETRY_MS = 30_000;

/** A song this device can play from its own storage. */
export interface LocalCopy {
  readonly track: OfflineTrack;
  /** The file's URI. */
  readonly uri: string;
  readonly profile: StreamProfile;
  readonly bytes: number;
  /** The cover's file, when the vault holds it. */
  readonly artUri: string | null;
}

/** Where one song a download keeps stands on this device. */
export type TrackDownloadState = "queued" | "downloading" | "downloaded" | "failed";

/** A download this device keeps, with its songs as far as the device knows them. */
export interface PinView {
  readonly pin: DownloadPin;
  /** Its songs in order, or null until its first manifest arrives. */
  readonly members: ReadonlyArray<StoredMember> | null;
}

/** Space downloads take on this device. */
export interface DownloadUsage {
  readonly tracks: number;
  /** Songs and covers. */
  readonly bytes: number;
  readonly freeBytes: number | null;
}

/** What screens read. Replaced, never mutated. */
export interface DownloadsSnapshot {
  /** The vault is open; until then this device knows of no downloads. */
  readonly ready: boolean;
  /** The server answers, so downloads can be added and files fetched. */
  readonly online: boolean;
  /** Free space ran low, so fetching waits. */
  readonly lowSpace: boolean;
  /** Downloads in the server's order (the vault's before it answers), less those being removed. */
  readonly pins: ReadonlyArray<PinView>;
  /** Every song this device holds or is getting. */
  readonly tracks: ReadonlyMap<TrackId, TrackDownloadState>;
  /** Every song this device holds. */
  readonly copies: ReadonlyMap<TrackId, LocalCopy>;
  readonly usage: DownloadUsage;
}

/** What `DownloadSync` works with. */
export interface DownloadSyncOptions {
  readonly client: Pick<MusicClient, "read" | "run">;
  readonly vault: VaultStore;
  readonly transfer: Transfer;
  readonly deviceId: DeviceId;
  /** Read at every plan, so a new download quality applies from the next fetch. */
  readonly policy: () => SyncPolicy;
  /** Turns a URL the server signed (relative behind the image's proxy) into one to fetch. */
  readonly resolveUrl: (url: string) => string;
  /** Milliseconds since the Unix epoch. */
  readonly now: () => number;
  /** Waits `ms`, or less when `signal` aborts; between polls of a file being prepared. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A fetch that didn't land, and when to try it again. */
interface Failure {
  readonly attempts: number;
  /** Null when only something new (a new manifest, a retry) should try again. */
  readonly retryAt: number | null;
  readonly message: string;
}

type FetchStep = Data.TaggedEnum.Value<SyncStep, "Fetch">;

/** The vault file a fetch writes, once the server said what type it is. */
interface Destination {
  file: string | null;
}

type FetchArtStep = Data.TaggedEnum.Value<SyncStep, "FetchArt">;

/** The snapshot before a vault opened: nothing held, nothing known. */
export const EMPTY_DOWNLOADS: DownloadsSnapshot = {
  ready: false,
  online: false,
  lowSpace: false,
  pins: [],
  tracks: new Map(),
  copies: new Map(),
  usage: { tracks: 0, bytes: 0, freeBytes: null },
};

/** Resolves after `ms`, or at once when `signal` aborts. */
const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, ms);

    signal.addEventListener("abort", done, { once: true });
  });

/** The next failure after `previous`, given whether trying again could help. */
const nextFailure = (
  previous: Failure | undefined,
  message: string,
  retryable: boolean,
  now: number,
): Failure => {
  const attempts = (previous?.attempts ?? 0) + 1;
  const wait = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (attempts - 1));

  return { attempts, retryAt: retryable ? now + wait : null, message };
};

/** Whether a failed fetch may run again now. */
const due = (failure: Failure | undefined, now: number): boolean =>
  failure === undefined || (failure.retryAt !== null && failure.retryAt <= now);

/** Keeps one device's downloads on it. One per vault. */
export class DownloadSync {
  readonly #options: DownloadSyncOptions;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #view: VaultRows = emptyVault;
  #ready = false;
  #stopped = false;
  #online = false;
  #lowSpace = false;
  #pins: Option.Option<ReadonlyArray<DownloadPin>> = Option.none();
  readonly #manifests = new Map<DownloadPinId, DownloadManifest>();
  /**
   * Files of copies that failed to play, not offered again in this session. A whole file stays
   * on disk, since playing may have failed for a passing reason; a broken one is fetched again.
   */
  readonly #discarded = new Set<string>();
  readonly #fetching = new Map<TrackId, { readonly rev: string; readonly stop: AbortController }>();
  readonly #fetchingArt = new Map<string, AbortController>();
  readonly #trackFailures = new Map<TrackId, Failure & { readonly rev: string }>();
  readonly #artFailures = new Map<string, Failure>();
  /** The songs the last plan fetches. */
  #wanted: ReadonlySet<TrackId> = new Set();
  #planning = false;
  #replan = false;
  #wake: ReturnType<typeof setTimeout> | null = null;
  #snapshot: DownloadsSnapshot = EMPTY_DOWNLOADS;
  readonly #listeners = new Set<() => void>();
  /** Plans, fetches, and checks still running: what `stop` waits for. */
  readonly #work = new Set<Promise<void>>();

  constructor(options: DownloadSyncOptions) {
    this.#options = options;
    this.#sleep = options.sleep ?? delay;
  }

  /**
   * Opens the vault: deletes rows whose file is gone and files no row names (a fetch the app was
   * killed in), then starts planning. Returns the function that stops every fetch.
   */
  start(): () => void {
    this.#tryOpen();

    return () => {
      void this.stop();
    };
  }

  /**
   * Stops every fetch and plan, and resolves once they have all ended: then nothing writes to the
   * vault or its files any more, and it can be closed or deleted.
   */
  async stop(): Promise<void> {
    this.#stop();

    const settle = async (): Promise<void> => {
      if (this.#work.size === 0) return;
      await Promise.allSettled(this.#work);

      return settle();
    };

    await settle();
  }

  /** The device's downloads, as `downloads.list` answered for it. */
  offerPins(pins: ReadonlyArray<DownloadPin>): void {
    this.#pins = Option.some(pins);
    this.#clearConfirmedRemovals();

    for (const pinId of this.#manifests.keys()) {
      if (!pins.some((pin) => pin.id === pinId)) this.#manifests.delete(pinId);
    }

    this.#plan();
  }

  /** What one download holds now, as `downloads.manifest` answered. */
  offerManifest(pinId: DownloadPinId, manifest: DownloadManifest): void {
    this.#manifests.set(pinId, manifest);
    this.#plan();
  }

  /** Whether the server answers. Fetching runs only while it does. */
  setOnline(online: boolean): void {
    if (online === this.#online) return;
    this.#online = online;
    this.#publish();
    this.#plan();
  }

  /**
   * Downloads `target` to this device and keeps it in sync.
   *
   * @throws The server's refusal (no access, too many downloads), or a lost connection.
   */
  async request(target: DownloadTarget): Promise<void> {
    await this.#options.client.run("downloads.add", {
      deviceId: this.#options.deviceId,
      kind: target.kind,
      id: target.id,
    });

    const key = targetKey(target);

    if (this.#view.removals.has(key)) await this.#commit(VaultChange.DeleteRemoval({ key }));
    this.#plan();
  }

  /**
   * Removes `target` from this device: its files go at once, also offline. The removal is kept in
   * the vault and sent to the server until the server stops listing the download, also across
   * restarts. If the server refuses it, the download comes back.
   *
   * @throws When the vault can't record the removal; nothing was removed then.
   */
  async remove(target: DownloadTarget): Promise<void> {
    await this.#commit(VaultChange.PutRemoval({ key: targetKey(target), target }));
    this.#plan();
    this.#sendRemoval(target);
  }

  /** Removes every download from this device. */
  async removeAll(): Promise<void> {
    await Promise.all(this.#snapshot.pins.map(({ pin }) => this.remove(pin.target)));
  }

  /** Tries the failed songs of `target` again now. */
  retry(target: DownloadTarget): void {
    const key = targetKey(target);
    const view = this.#snapshot.pins.find(({ pin }) => targetKey(pin.target) === key);

    const members =
      target.kind === "track" ? [target.id] : (view?.members ?? []).map((member) => member.trackId);

    for (const trackId of members) this.#trackFailures.delete(trackId);
    this.#plan();
  }

  /** The copy of `trackId` this device holds, or null. Reads the vault's rows, not a snapshot. */
  localCopy(trackId: TrackId): LocalCopy | null {
    const copy = this.#view.copies.get(trackId);

    return copy === undefined || this.#discarded.has(copy.file) ? null : this.#localCopy(copy);
  }

  /**
   * The copy of `trackId` at `uri` failed to play, and stops being offered at once. When its file
   * is missing or not the size it was fetched at, it is deleted and fetched again. A whole file
   * stays on disk for the next session: the failure may have been a passing one (an interruption,
   * a slow start), and offline it is the only copy. A copy a newer one replaced meanwhile changes
   * nothing.
   */
  discard(trackId: TrackId, uri: string): void {
    const copy = this.#view.copies.get(trackId);
    const { vault } = this.#options;

    if (copy === undefined || vault.uri(copy.file) !== uri || this.#discarded.has(copy.file)) {
      return;
    }

    this.#discarded.add(copy.file);

    const check = async (): Promise<void> => {
      if ((await vault.size(copy.file)) === copy.bytes) return;
      await this.#drop(copy);
      // The next copy has the same name; it is offered once it lands.
      this.#discarded.delete(copy.file);
      this.#plan();
    };

    this.#track(check()).catch(() => {
      this.#wakeIn(VAULT_RETRY_MS);
    });
  }

  /** The current snapshot, for `useSyncExternalStore`. */
  getSnapshot = (): DownloadsSnapshot => this.#snapshot;

  /** Calls `listener` after every new snapshot. Returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  async #open(): Promise<void> {
    const { vault } = this.#options;
    this.#view = await vault.load();
    const files = new Set(await vault.files());

    const lost = [
      ...Array.from(this.#view.copies.values()).flatMap((copy) =>
        files.has(copy.file)
          ? []
          : [VaultChange.DeleteCopy({ trackId: copy.track.id, file: copy.file })],
      ),
      ...Array.from(this.#view.art.values()).flatMap((art) =>
        files.has(art.file) ? [] : [VaultChange.DeleteArt({ hash: art.hash })],
      ),
    ];

    await Promise.all(lost.map((change) => this.#commit(change)));

    const named = new Set([
      ...Array.from(this.#view.copies.values(), (copy) => copy.file),
      ...Array.from(this.#view.art.values(), (art) => art.file),
    ]);

    await Promise.all([...files].flatMap((file) => (named.has(file) ? [] : [vault.remove(file)])));

    if (this.#stopped) return;
    this.#ready = true;
    this.#clearConfirmedRemovals();

    // Removals the app was killed before the server heard of: tell it again.
    for (const target of this.#view.removals.values()) this.#sendRemoval(target);
    this.#plan();
  }

  /** Tells the server this device no longer keeps `target`; a refusal brings the download back. */
  #sendRemoval(target: DownloadTarget): void {
    const key = targetKey(target);

    const send = async (): Promise<void> => {
      try {
        await this.#options.client.run("downloads.remove", {
          deviceId: this.#options.deviceId,
          kind: target.kind,
          id: target.id,
        });
      } catch {
        await this.#commit(VaultChange.DeleteRemoval({ key }));
        this.#plan();
      }
    };

    void send().catch(() => undefined);
  }

  /** Forgets removals the server confirmed by no longer listing their download. */
  #clearConfirmedRemovals(): void {
    if (!this.#ready) return;

    const listed = Option.match(this.#pins, {
      onNone: () => null,
      onSome: (pins) => new Set(pins.map((pin) => targetKey(pin.target))),
    });

    if (listed === null) return;

    for (const key of this.#view.removals.keys()) {
      if (!listed.has(key)) {
        void this.#commit(VaultChange.DeleteRemoval({ key })).catch(() => undefined);
      }
    }
  }

  /** Opens the vault, and tries again later when it can't be read (a full disk, say). */
  #tryOpen(): void {
    void this.#open().catch(() => {
      if (this.#stopped) return;

      this.#wake = setTimeout(() => {
        this.#wake = null;
        this.#tryOpen();
      }, VAULT_RETRY_MS);
    });
  }

  #stop(): void {
    this.#stopped = true;

    for (const { stop } of this.#fetching.values()) stop.abort();

    for (const stop of this.#fetchingArt.values()) stop.abort();

    if (this.#wake !== null) clearTimeout(this.#wake);
    this.#wake = null;
  }

  #plan(): void {
    if (!this.#ready || this.#stopped) return;

    if (this.#planning) {
      this.#replan = true;

      return;
    }

    this.#planning = true;
    this.#replan = false;

    void this.#track(this.#planOnce())
      .catch(() => {
        this.#wakeIn(VAULT_RETRY_MS);
      })
      .finally(() => {
        this.#planning = false;
        this.#publish();

        if (this.#replan) this.#plan();
      });
  }

  /** Plans once: applies the cheap steps together, then starts the fetches there is room for. */
  async #planOnce(): Promise<void> {
    const steps = planSync(
      {
        pins: this.#pins,
        manifests: this.#manifests,
        removing: new Set(this.#view.removals.keys()),
      },
      this.#view,
      this.#options.policy(),
    );

    const fetches = steps.filter(SyncStep.$is("Fetch"));
    const covers = steps.filter(SyncStep.$is("FetchArt"));

    // Each step writes its own row and file, so they don't wait on one another.
    await Promise.all(
      steps.map((step) =>
        SyncStep.$match(step, {
          SavePin: ({ pin }) => this.#commit(VaultChange.PutPin({ pin })),
          ForgetPin: ({ pinId }) => this.#commit(VaultChange.DeletePin({ pinId })),
          Refresh: ({ copy }) => this.#commit(VaultChange.UpdateCopy({ copy })),
          Drop: ({ copy }) => this.#drop(copy),
          DropArt: ({ art }) => this.#dropArt(art),
          Fetch: () => Promise.resolve(),
          FetchArt: () => Promise.resolve(),
        }),
      ),
    );

    if (this.#stopped) return;
    this.#follow(fetches, covers);
    const free = this.#options.vault.freeBytes();
    this.#lowSpace = free !== null && free < MIN_FREE_BYTES;

    if (this.#online && !this.#lowSpace) this.#startFetches(fetches, covers);
    this.#scheduleWake();
  }

  /** Stops fetches the plan no longer wants and forgets their failures. */
  #follow(fetches: ReadonlyArray<FetchStep>, covers: ReadonlyArray<FetchArtStep>): void {
    const revs = new Map(fetches.map(({ entry }) => [entry.track.id, entry.rev]));
    const hashes = new Set(covers.map(({ hash }) => hash));
    this.#wanted = new Set(revs.keys());

    for (const [trackId, running] of this.#fetching) {
      if (revs.get(trackId) !== running.rev) running.stop.abort();
    }

    for (const [hash, stop] of this.#fetchingArt) if (!hashes.has(hash)) stop.abort();

    for (const [trackId, failure] of this.#trackFailures) {
      if (revs.get(trackId) !== failure.rev) this.#trackFailures.delete(trackId);
    }

    for (const hash of this.#artFailures.keys()) {
      if (!hashes.has(hash)) this.#artFailures.delete(hash);
    }
  }

  #startFetches(fetches: ReadonlyArray<FetchStep>, covers: ReadonlyArray<FetchArtStep>): void {
    const now = this.#options.now();
    const free = () => this.#fetching.size + this.#fetchingArt.size < MAX_TRANSFERS;

    for (const cover of covers) {
      if (!free()) return;

      const failure = this.#artFailures.get(cover.hash);

      if (!this.#fetchingArt.has(cover.hash) && due(failure, now)) {
        // The retry is under way: it no longer waits for its time.
        if (failure !== undefined) this.#artFailures.set(cover.hash, { ...failure, retryAt: null });
        void this.#track(this.#fetchArt(cover));
      }
    }

    for (const fetch of fetches) {
      if (!free()) return;
      const trackId = fetch.entry.track.id;

      const failure = this.#trackFailures.get(trackId);

      if (!this.#fetching.has(trackId) && due(failure, now)) {
        // The retry is under way: it no longer waits for its time.
        if (failure !== undefined) this.#trackFailures.set(trackId, { ...failure, retryAt: null });
        void this.#track(this.#fetchTrack(fetch));
      }
    }
  }

  async #fetchTrack({ entry, profile }: FetchStep): Promise<void> {
    const { client, vault, resolveUrl, now } = this.#options;
    const trackId = entry.track.id;
    const stop = new AbortController();
    const written: Destination = { file: null };
    this.#fetching.set(trackId, { rev: entry.rev, stop });
    this.#publish();

    /** Records a fetch that didn't land and deletes what it wrote, which no row names. */
    const fail = async (message: string, retryable: boolean): Promise<void> => {
      const failure = nextFailure(this.#trackFailures.get(trackId), message, retryable, now());
      this.#trackFailures.set(trackId, { ...failure, rev: entry.rev });
      await this.#removeQuietly(written.file);
    };

    try {
      const outcome = await fetchFinishedFile(this.#options.transfer, {
        sign: async () => {
          const stream = await client.read("stream.url", { trackId, profile, requestedAt: now() });

          return resolveUrl(stream.url);
        },
        destination: (contentType) => {
          written.file = audioFile(trackId, entry.rev, profile, contentType);

          return written.file === null ? null : vault.uri(written.file);
        },
        signal: stop.signal,
        sleep: this.#sleep,
      });

      await FetchOutcome.$match(outcome, {
        Fetched: async ({ bytes }) => {
          // A stopped sync's vault is closing; the next start's sweep deletes the file.
          if (this.#stopped || written.file === null) return;
          const previous = this.#view.copies.get(trackId);

          const copy: StoredCopy = {
            track: entry.track,
            rev: entry.rev,
            profile,
            file: written.file,
            bytes,
            artHash: entry.artHash,
          };

          await this.#commit(VaultChange.PutCopy({ copy }));
          this.#trackFailures.delete(trackId);

          if (previous !== undefined && previous.file !== copy.file) {
            await this.#removeQuietly(previous.file);
          }
        },
        Gone: () => fail("The song is no longer on the server", true),
        Failed: ({ message, retryable }) => fail(message, retryable),
        Stopped: () => {
          // Stopped for a new revision, a removal, or the vault closing: no retry is owed.
          this.#trackFailures.delete(trackId);

          return this.#removeQuietly(written.file);
        },
      });
    } catch (error) {
      // The vault refused the row (a full disk, say): try again later, as after a failed fetch.
      await fail(error instanceof Error ? error.message : "Couldn’t keep the song", true);
    } finally {
      // Held until the copy is in the vault, so no plan in between fetches it again.
      this.#fetching.delete(trackId);
      this.#plan();
    }
  }

  async #fetchArt({ hash, url }: FetchArtStep): Promise<void> {
    const { transfer, vault, resolveUrl, now } = this.#options;
    const file = artFile(hash);

    if (file === null) {
      this.#artFailures.set(hash, nextFailure(undefined, "Unusable cover", false, now()));

      return;
    }

    const stop = new AbortController();
    this.#fetchingArt.set(hash, stop);

    const fail = async (message: string): Promise<void> => {
      this.#artFailures.set(hash, nextFailure(this.#artFailures.get(hash), message, true, now()));
      await this.#removeQuietly(file);
    };

    try {
      const result = await transfer.download({
        url: resolveUrl(url),
        destination: vault.uri(file),
        signal: stop.signal,
      });

      await DownloadResult.$match(result, {
        Written: async ({ bytes }) => {
          if (stop.signal.aborted || this.#stopped) {
            await this.#removeQuietly(file);

            return;
          }

          await this.#commit(VaultChange.PutArt({ art: { hash, file, bytes } }));
          this.#artFailures.delete(hash);
        },
        Refused: ({ status }) => fail(`The media service answered ${String(status)}`),
        Broken: ({ message }) => fail(message),
      });
    } catch (error) {
      await fail(error instanceof Error ? error.message : "Couldn’t keep the cover");
    } finally {
      this.#fetchingArt.delete(hash);
      this.#plan();
    }
  }

  /** Counts `work` as running until it ends, for `stop`. */
  #track(work: Promise<void>): Promise<void> {
    this.#work.add(work);

    void work
      .catch(() => undefined)
      .finally(() => {
        this.#work.delete(work);
      });

    return work;
  }

  /** Deletes a vault file if there is one; a file left behind goes with the next start's sweep. */
  async #removeQuietly(file: string | null): Promise<void> {
    if (file === null) return;

    await this.#options.vault.remove(file).catch(() => undefined);
  }

  async #drop(copy: StoredCopy): Promise<void> {
    await this.#commit(VaultChange.DeleteCopy({ trackId: copy.track.id, file: copy.file }));
    await this.#options.vault.remove(copy.file);
  }

  async #dropArt(art: StoredArt): Promise<void> {
    await this.#commit(VaultChange.DeleteArt({ hash: art.hash }));
    await this.#options.vault.remove(art.file);
  }

  async #commit(change: VaultChange): Promise<void> {
    await this.#options.vault.commit(change);
    this.#view = applyChange(this.#view, change);
    this.#publish();
  }

  /**
   * Wakes the sync for the next retry that could start then, and to check space again while it is
   * low. A retry that is due waits for nothing while no fetch can start (offline, low on space,
   * both slots busy): the connection coming back or a fetch ending plans again.
   */
  #scheduleWake(): void {
    const now = this.#options.now();

    const canStart =
      this.#online &&
      !this.#lowSpace &&
      this.#fetching.size + this.#fetchingArt.size < MAX_TRANSFERS;

    const retries = canStart
      ? [
          ...Array.from(this.#trackFailures, ([trackId, { retryAt }]) =>
            this.#fetching.has(trackId) ? null : retryAt,
          ),
          ...Array.from(this.#artFailures, ([hash, { retryAt }]) =>
            this.#fetchingArt.has(hash) ? null : retryAt,
          ),
        ].flatMap((retryAt) => (retryAt === null ? [] : [retryAt - now]))
      : [];

    const waits = this.#lowSpace ? [...retries, SPACE_RECHECK_MS] : retries;

    if (waits.length === 0) return;
    this.#wakeIn(Math.max(0, Math.min(...waits)));
  }

  #wakeIn(ms: number): void {
    if (this.#wake !== null) clearTimeout(this.#wake);

    this.#wake = setTimeout(() => {
      this.#wake = null;
      this.#plan();
    }, ms);
  }

  #localCopy(copy: StoredCopy): LocalCopy {
    const art = copy.artHash === null ? undefined : this.#view.art.get(copy.artHash);
    const { uri } = this.#options.vault;

    return {
      track: copy.track,
      uri: uri(copy.file),
      profile: copy.profile,
      bytes: copy.bytes,
      artUri: art === undefined ? null : uri(art.file),
    };
  }

  /** The downloads this device keeps, as screens list them. */
  #pinViews(): ReadonlyArray<PinView> {
    const listed = Option.getOrElse(this.#pins, () =>
      Array.from(this.#view.pins.values(), (stored) => stored.pin),
    );

    return listed.flatMap((listedPin) => {
      if (this.#view.removals.has(targetKey(listedPin.target))) return [];
      const manifest = this.#manifests.get(listedPin.id);
      const stored = this.#view.pins.get(listedPin.id);

      if (manifest !== undefined) {
        const members = manifest.entries.map((entry) => ({
          trackId: entry.track.id,
          state: entry.state,
        }));

        return [{ pin: manifest.pin, members }];
      }

      return [{ pin: stored?.pin ?? listedPin, members: stored?.members ?? null }];
    });
  }

  #trackStates(copies: ReadonlyMap<TrackId, LocalCopy>): ReadonlyMap<TrackId, TrackDownloadState> {
    const states = new Map<TrackId, TrackDownloadState>();

    for (const trackId of copies.keys()) states.set(trackId, "downloaded");

    for (const trackId of this.#wanted) {
      if (states.has(trackId)) continue;

      if (this.#fetching.has(trackId)) states.set(trackId, "downloading");
      else if (this.#trackFailures.has(trackId)) states.set(trackId, "failed");
      else states.set(trackId, "queued");
    }

    return states;
  }

  #publish(): void {
    const copies = new Map(
      Array.from(this.#view.copies.values(), (copy) => [copy.track.id, this.#localCopy(copy)]),
    );

    let bytes = 0;

    for (const copy of this.#view.copies.values()) bytes += copy.bytes;

    for (const art of this.#view.art.values()) bytes += art.bytes;

    this.#snapshot = {
      ready: this.#ready,
      online: this.#online,
      lowSpace: this.#lowSpace,
      pins: this.#pinViews(),
      tracks: this.#trackStates(copies),
      copies,
      usage: { tracks: copies.size, bytes, freeBytes: this.#options.vault.freeBytes() },
    };

    for (const listener of this.#listeners) listener();
  }
}
