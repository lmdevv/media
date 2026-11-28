import type { Data } from "effect";
import { Equal, Option } from "effect";

import { DownloadResult, fetchFinishedFile, FetchOutcome } from "./finished-file";
import type { Transfer } from "./finished-file";
import type {
  DownloadManifest,
  DownloadPin,
  DownloadPinId,
  DownloadTarget,
  LyricsChange,
  LyricsRevision,
  OfflineLyrics,
  OfflineTrack,
  StreamProfile,
  TrackId,
} from "./models";
import {
  artHashOf,
  keptSongs,
  lyricsQuestions,
  pinIdOf,
  planSync,
  SyncStep,
  targetKey,
  UNKNOWN_REVISION,
} from "./plan";
import type {
  Desired,
  ListedLyrics,
  LyricsQuestion,
  NewLyrics,
  StoredArt,
  StoredCopy,
  StoredMember,
  SyncPolicy,
} from "./plan";
import { transferGate } from "./transfer-gate";
import type { StartedBy, TransferConditions } from "./transfer-gate";
import { applyChange, artFile, audioFile, emptyVault, VaultChange } from "./vault";
import type { VaultRows, VaultStore } from "./vault";

const MAX_TRANSFERS = 2;

const MIN_FREE_BYTES = 1024 ** 3;

const SPACE_RECHECK_MS = 60_000;

const FIRST_RETRY_MS = 10_000;

const MAX_RETRY_MS = 10 * 60_000;

const VAULT_RETRY_MS = 30_000;

const LYRICS_CACHE_SIZE = 4;

/** A song this device can play from its own storage. */
export interface LocalCopy {
  readonly track: OfflineTrack;
  /** The file's URI. */
  readonly uri: string;
  readonly profile: StreamProfile;
  /** Space the song takes here: its file and its lyrics. */
  readonly bytes: number;
  /** The cover's file, when the vault holds it. */
  readonly artUri: string | null;
}

/**
 * The lyrics this device keeps for a song, as Now Playing reads them: none, `loading` while they
 * are read from the vault (`DownloadSync.loadLyrics`), or the lyrics.
 */
export type LocalLyrics = OfflineLyrics | "loading" | null;

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
  /** Songs, covers, and lyrics. */
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
  /** Wi-Fi only holds every transfer: the phone is on mobile data, a hotspot, or Low Data Mode. */
  readonly waitingForWifi: boolean;
  /** Downloads in the server's order (the vault's before it answers), less those being removed. */
  readonly pins: ReadonlyArray<PinView>;
  /** Every song this device holds or is getting. */
  readonly tracks: ReadonlyMap<TrackId, TrackDownloadState>;
  /** Every song this device holds. */
  readonly copies: ReadonlyMap<TrackId, LocalCopy>;
  readonly usage: DownloadUsage;
  /**
   * The kept songs whose lyrics here are behind the server's, one batch per question; hand the
   * lyrics found to `offerLyrics`. Recomputed once a plan has applied what it could, and the same
   * array until a question changes.
   */
  readonly lyricsQuestions: ReadonlyArray<LyricsQuestion>;
}

/** What names a download until its songs are read: its title, artist or owner, and cover. */
export interface PinDetails {
  readonly title: string;
  readonly subtitle: string;
  readonly artUrl: string | null;
}

interface DownloadTicket {
  readonly url: string;
  /** The revision of the file the ticket is for, which the copy is kept at. */
  readonly revision: string;
}

/**
 * The core's downloads service as this phone's sync calls it (ADR 0019): it keeps each song this
 * phone holds against the device's download limit, and gives a 15-minute ticket to fetch one.
 */
export interface DownloadsCore {
  /** Keeps a song on this device (`core.downloads.add`). Rejects with the core's refusal. */
  readonly keep: (trackId: TrackId) => Promise<void>;
  /** Stops keeping a song on this device (`core.downloads.remove`). */
  readonly release: (trackId: TrackId) => Promise<void>;
  /**
   * A finished-file stream URL for a kept song at `profile`, with a fresh download ticket
   * (`core.downloads.fetch`). Rejects when the core no longer serves it to this device.
   */
  readonly ticket: (trackId: TrackId, profile: StreamProfile) => Promise<DownloadTicket>;
  /** Turns a path on the media server, such as a cover's, into a URL to fetch. */
  readonly resolveUrl: (url: string) => string;
}

/** What `DownloadSync` works with. */
export interface DownloadSyncOptions {
  readonly core: DownloadsCore;
  readonly vault: VaultStore;
  readonly transfer: Transfer;
  /** Read at every plan, so a new download quality applies from the next fetch. */
  readonly policy: () => SyncPolicy;
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
  waitingForWifi: false,
  pins: [],
  tracks: new Map(),
  copies: new Map(),
  usage: { tracks: 0, bytes: 0, freeBytes: null },
  lyricsQuestions: [],
};

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

/** Which songs and covers may start a transfer now. */
interface Startable {
  readonly song: (trackId: TrackId) => boolean;
  readonly art: (hash: string) => boolean;
}

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
  /**
   * What starting a transfer depends on besides the server (`transferGate`). A sync no one told
   * otherwise transfers on any network; the app sets them before `start`.
   */
  #conditions: TransferConditions = { metered: false, wifiOnly: false, lowPower: false };
  /** The downloads the person started while Low Power Mode is on, which fetch all the same. */
  readonly #asked = new Set<DownloadPinId>();
  /** The songs the person tried again while Low Power Mode is on, which fetch all the same. */
  readonly #askedSongs = new Set<TrackId>();
  /**
   * What the core keeps on this device, with each song's lyrics revision, as
   * `core.downloads.list` answered; none until it does.
   */
  #listed: Option.Option<ListedLyrics> = Option.none();
  readonly #releasing = new Set<TrackId>();
  readonly #manifests = new Map<DownloadPinId, DownloadManifest>();
  readonly #lyrics = new Map<TrackId, LyricsChange>();
  #questions: ReadonlyArray<LyricsQuestion> = [];
  readonly #readLyrics = new Map<
    TrackId,
    { readonly rev: LyricsRevision; readonly lyrics: OfflineLyrics | null }
  >();
  readonly #readingLyrics = new Set<TrackId>();
  readonly #discarded = new Set<string>();
  readonly #fetching = new Map<TrackId, { readonly rev: string; readonly stop: AbortController }>();
  readonly #fetchingArt = new Map<string, AbortController>();
  readonly #trackFailures = new Map<TrackId, Failure & { readonly rev: string }>();
  readonly #artFailures = new Map<string, Failure>();
  #wanted: ReadonlySet<TrackId> = new Set();
  #planning = false;
  #replan = false;
  #wake: ReturnType<typeof setTimeout> | null = null;
  #snapshot: DownloadsSnapshot = EMPTY_DOWNLOADS;
  readonly #listeners = new Set<() => void>();
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

  /**
   * Stops every fetch and plan, then, while the server answers, releases on the core every song
   * it keeps on this device for this account: those it listed, and those this phone holds or
   * was fetching. Resolves once every release answered. For signing out: the vault is deleted
   * next, so nothing here would release them later. Offline it only stops, and the core keeps
   * them until this account opens an empty vault here and its first plan releases them.
   */
  async releaseAll(): Promise<void> {
    const releasing = this.#online;

    const songs = new Set([
      ...Option.getOrElse(this.#listed, (): ListedLyrics => new Map()).keys(),
      ...this.#view.copies.keys(),
      ...this.#wanted,
    ]);

    await this.stop();

    if (!releasing) return;

    await Promise.allSettled([...songs].map((trackId) => this.#options.core.release(trackId)));
  }

  /**
   * The songs the core keeps on this device, with the revision of each one's lyrics, as
   * `core.downloads.list` answered. A song it keeps that no download here holds any more is
   * released, as after a removal made offline. A kept song's lyrics are asked for only while
   * this phone keeps them at another revision (`lyricsQuestions`).
   */
  offerKept(listed: ListedLyrics): void {
    this.#listed = Option.some(listed);
    this.#plan();
  }

  /** What one download holds now, from the core's album, playlist, or song read. */
  offerManifest(pinId: DownloadPinId, manifest: DownloadManifest): void {
    this.#manifests.set(pinId, manifest);
    this.#plan();
  }

  offerLyrics(changes: ReadonlyArray<LyricsChange>): void {
    if (changes.length === 0) return;

    for (const change of changes) this.#lyrics.set(change.trackId, change);
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
   * Whether Low Power Mode is on. While it is, no transfer starts on its own: only those of a
   * download the person starts, or of songs they try again, while it is on. Transfers already
   * running go on. Turning it off starts the rest.
   */
  setLowPower(on: boolean): void {
    if (on === this.#conditions.lowPower) return;
    this.#asked.clear();
    this.#askedSongs.clear();
    this.#setConditions({ ...this.#conditions, lowPower: on });
  }

  /**
   * Whether the phone's network is metered (`meteredOf`). With Wi-Fi only on, a metered network
   * stops the transfers running, which start over once it is not.
   */
  setMetered(metered: boolean): void {
    this.#setConditions({ ...this.#conditions, metered });
  }

  /** The Wi-Fi only setting: while it is on, no transfer runs on a metered network. */
  setWifiOnly(on: boolean): void {
    this.#setConditions({ ...this.#conditions, wifiOnly: on });
  }

  /**
   * Downloads `target` to this device and keeps it in sync: the phone keeps the download, and its
   * songs are kept on the core one by one as they are fetched. `details` name it until its songs
   * are read.
   *
   * @throws When the vault can't record the download; nothing was added then.
   */
  async request(target: DownloadTarget, details: PinDetails): Promise<void> {
    const id = pinIdOf(target);

    if (this.#view.pins.has(id)) return;

    await this.#commit(
      VaultChange.PutPin({
        pin: {
          pin: {
            id,
            target,
            createdAt: this.#options.now(),
            available: true,
            title: details.title,
            subtitle: details.subtitle,
            artUrl: details.artUrl,
            artHash: artHashOf(details.artUrl),
          },
          members: [],
        },
      }),
    );

    if (this.#conditions.lowPower) this.#asked.add(id);
    this.#plan();
  }

  /**
   * Removes `target` from this device: its files go at once, also offline, and the core stops
   * keeping its songs once it answers.
   *
   * @throws When the vault can't record the removal; nothing was removed then.
   */
  async remove(target: DownloadTarget): Promise<void> {
    const id = pinIdOf(target);

    this.#manifests.delete(id);
    await this.#commit(VaultChange.DeletePin({ pinId: id }));
    this.#plan();
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

    for (const trackId of members) {
      this.#trackFailures.delete(trackId);

      if (this.#conditions.lowPower) this.#askedSongs.add(trackId);
    }

    this.#plan();
  }

  /**
   * The lyrics this device keeps for `trackId`: null for none, `loading` until `loadLyrics` read
   * them. Returns the same value until the vault's rows or the read change.
   */
  localLyrics(trackId: TrackId): LocalLyrics {
    const stored = this.#view.lyrics.get(trackId);

    if (stored === undefined) return null;
    const read = this.#readLyrics.get(trackId);

    return read?.rev === stored.rev ? read.lyrics : "loading";
  }

  /**
   * Reads the lyrics kept for `trackId` from the vault, when `localLyrics` says `loading`, and
   * tells subscribers once they are in. Lyrics that no longer read as lyrics are forgotten, so
   * the server sends them again; a read that fails shows none until they change.
   */
  loadLyrics(trackId: TrackId): void {
    const stored = this.#view.lyrics.get(trackId);

    if (
      stored === undefined ||
      this.#readLyrics.get(trackId)?.rev === stored.rev ||
      this.#readingLyrics.has(trackId)
    ) {
      return;
    }

    this.#readingLyrics.add(trackId);

    const read = async (): Promise<void> => {
      const kept = await this.#options.vault.lyrics(trackId);

      this.#readingLyrics.delete(trackId);

      if (kept === null) {
        if (this.#view.lyrics.get(trackId)?.rev !== stored.rev) {
          this.loadLyrics(trackId);

          return;
        }

        await this.#commit(VaultChange.DeleteLyrics({ trackIds: [trackId] }));
        this.#plan();

        return;
      }

      this.#rememberLyrics(trackId, kept.rev, kept.lyrics);
      this.loadLyrics(trackId);
    };

    this.#track(read()).catch(() => {
      this.#readingLyrics.delete(trackId);
      this.#rememberLyrics(trackId, stored.rev, null);
    });
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
    this.#plan();
  }

  /**
   * Releases on the core every song it keeps on this device that no download here holds, once
   * the core listed them and while it answers. A release that fails is sent again at a later plan.
   */
  #release(kept: ReadonlySet<TrackId>): void {
    if (!this.#online) return;

    const listed = Option.getOrElse(this.#listed, (): ListedLyrics => new Map());

    for (const trackId of listed.keys()) {
      if (kept.has(trackId) || this.#releasing.has(trackId) || this.#fetching.has(trackId)) {
        continue;
      }

      this.#releasing.add(trackId);

      void this.#track(
        this.#options.core.release(trackId).finally(() => {
          this.#releasing.delete(trackId);
        }),
      ).catch(() => undefined);
    }
  }

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
        this.#askAgain();
        this.#publish();

        if (this.#replan) this.#plan();
      });
  }

  async #planOnce(): Promise<void> {
    const desired = this.#desired();
    const offered = new Map(this.#lyrics);
    const steps = planSync(desired, this.#view, this.#options.policy());
    const fetches = steps.filter(SyncStep.$is("Fetch"));
    const covers = steps.filter(SyncStep.$is("FetchArt"));
    const saved: Array<NewLyrics> = [];
    const dropped: Array<TrackId> = [];

    for (const step of steps) {
      if (SyncStep.$is("SaveLyrics")(step)) saved.push(step.lyrics);

      if (SyncStep.$is("DropLyrics")(step)) dropped.push(step.trackId);
    }

    await Promise.all([
      ...steps.map((step) =>
        SyncStep.$match(step, {
          SavePin: ({ pin }) => this.#commit(VaultChange.PutPin({ pin })),
          ForgetPin: ({ pinId }) => this.#commit(VaultChange.DeletePin({ pinId })),
          Refresh: ({ copy }) => this.#commit(VaultChange.UpdateCopy({ copy })),
          Drop: ({ copy }) => this.#drop(copy),
          DropArt: ({ art }) => this.#dropArt(art),
          SaveLyrics: () => Promise.resolve(),
          DropLyrics: () => Promise.resolve(),
          Fetch: () => Promise.resolve(),
          FetchArt: () => Promise.resolve(),
        }),
      ),
      saved.length === 0
        ? Promise.resolve()
        : this.#commit(VaultChange.PutLyrics({ lyrics: saved })),
      dropped.length === 0
        ? Promise.resolve()
        : this.#commit(VaultChange.DeleteLyrics({ trackIds: dropped })),
    ]);

    for (const [trackId, change] of offered) {
      if (this.#lyrics.get(trackId) === change) this.#lyrics.delete(trackId);
    }

    if (this.#stopped) return;
    this.#release(keptSongs(desired, this.#view));
    this.#follow(fetches, covers);
    const free = this.#options.vault.freeBytes();
    this.#lowSpace = free !== null && free < MIN_FREE_BYTES;

    if (this.#online && !this.#lowSpace) this.#startFetches(fetches, covers);
    this.#scheduleWake();
  }

  #rememberLyrics(trackId: TrackId, rev: LyricsRevision, lyrics: OfflineLyrics | null): void {
    this.#readLyrics.delete(trackId);
    this.#readLyrics.set(trackId, { rev, lyrics });

    for (const old of this.#readLyrics.keys()) {
      if (this.#readLyrics.size <= LYRICS_CACHE_SIZE) break;
      this.#readLyrics.delete(old);
    }

    this.#notify();
  }

  #askAgain(): void {
    const questions = lyricsQuestions(
      this.#desired(),
      this.#view,
      Option.getOrElse(this.#listed, (): ListedLyrics => new Map()),
    );

    if (Equal.equals(questions, this.#questions)) return;

    // A question that didn't change stays the same object, so its watcher keeps the lookups it
    // has in flight while another bucket's answers land.
    const before = new Map(this.#questions.map((question) => [question.key, question]));

    this.#questions = questions.map((question) => {
      const same = before.get(question.key);

      return same !== undefined && Equal.equals(same, question) ? same : question;
    });
  }

  #desired(): Desired {
    return {
      pins: Option.none(),
      manifests: this.#manifests,
      removing: new Set(),
      lyrics: this.#lyrics,
    };
  }

  #follow(fetches: ReadonlyArray<FetchStep>, covers: ReadonlyArray<FetchArtStep>): void {
    const revs = new Map(fetches.map(({ entry }) => [entry.track.id, entry.rev]));
    const hashes = new Set(covers.map(({ hash }) => hash));
    this.#wanted = new Set(revs.keys());

    for (const [trackId, running] of this.#fetching) {
      const rev = revs.get(trackId);

      // A fetch started before the core named the revision goes on: it fetches the current one.
      if (rev === undefined || (rev !== running.rev && running.rev !== UNKNOWN_REVISION)) {
        running.stop.abort();
      }
    }

    for (const [hash, stop] of this.#fetchingArt) if (!hashes.has(hash)) stop.abort();

    for (const [trackId, failure] of this.#trackFailures) {
      if (revs.get(trackId) !== failure.rev) this.#trackFailures.delete(trackId);
    }

    for (const hash of this.#artFailures.keys()) {
      if (!hashes.has(hash)) this.#artFailures.delete(hash);
    }
  }

  #setConditions(next: TransferConditions): void {
    const before = this.#conditions;

    if (
      next.metered === before.metered &&
      next.wifiOnly === before.wifiOnly &&
      next.lowPower === before.lowPower
    ) {
      return;
    }

    this.#conditions = next;

    // Wi-Fi only stops what runs as well as what would start: mobile data spent on a transfer
    // already running is spent all the same. Low Power Mode lets running transfers finish.
    if (transferGate(next, "person") === "wifi") {
      for (const { stop } of this.#fetching.values()) stop.abort();

      for (const stop of this.#fetchingArt.values()) stop.abort();
    }

    this.#publish();
    this.#plan();
  }

  /**
   * Which songs and covers may start a transfer now, by `transferGate`: those the person asked for
   * while Low Power Mode is on count as theirs, every other one as the sync's.
   */
  #mayStart(): Startable {
    const gate = (startedBy: StartedBy): boolean =>
      transferGate(this.#conditions, startedBy) === "run";

    if (gate("sync")) return { song: () => true, art: () => true };

    if (!gate("person")) return { song: () => false, art: () => false };

    const songs = new Set(this.#askedSongs);
    const art = new Set<string>();

    for (const pinId of this.#asked) {
      const manifest = this.#manifests.get(pinId);
      const pin = manifest?.pin ?? this.#view.pins.get(pinId)?.pin;

      if (pin?.available === true && pin.artHash !== null) art.add(pin.artHash);

      for (const entry of manifest?.entries ?? []) songs.add(entry.track.id);
    }

    for (const manifest of this.#manifests.values()) {
      for (const entry of manifest.entries) {
        if (entry.artHash !== null && songs.has(entry.track.id)) art.add(entry.artHash);
      }
    }

    return { song: (trackId) => songs.has(trackId), art: (hash) => art.has(hash) };
  }

  #startFetches(fetches: ReadonlyArray<FetchStep>, covers: ReadonlyArray<FetchArtStep>): void {
    const now = this.#options.now();
    const free = () => this.#fetching.size + this.#fetchingArt.size < MAX_TRANSFERS;
    const may = this.#mayStart();

    for (const cover of covers) {
      if (!free()) return;

      if (!may.art(cover.hash)) continue;

      // The plan read the vault before its saves; a cover that landed since must not be fetched
      // again, as a second download replaces the file and its abort deletes it.
      if (this.#view.art.has(cover.hash)) continue;

      const failure = this.#artFailures.get(cover.hash);

      if (!this.#fetchingArt.has(cover.hash) && due(failure, now)) {
        if (failure !== undefined) this.#artFailures.set(cover.hash, { ...failure, retryAt: null });
        void this.#track(this.#fetchArt(cover));
      }
    }

    for (const fetch of fetches) {
      if (!free()) return;
      const trackId = fetch.entry.track.id;

      if (!may.song(trackId)) continue;

      const failure = this.#trackFailures.get(trackId);

      if (!this.#fetching.has(trackId) && due(failure, now)) {
        if (failure !== undefined) this.#trackFailures.set(trackId, { ...failure, retryAt: null });
        void this.#track(this.#fetchTrack(fetch));
      }
    }
  }

  async #fetchTrack({ entry, profile }: FetchStep): Promise<void> {
    const { core, vault, now } = this.#options;
    const trackId = entry.track.id;
    const stop = new AbortController();
    const written: Destination = { file: null };
    const fetched = { rev: entry.rev };
    this.#fetching.set(trackId, { rev: entry.rev, stop });
    this.#publish();

    const fail = async (message: string, retryable: boolean): Promise<void> => {
      const failure = nextFailure(this.#trackFailures.get(trackId), message, retryable, now());
      this.#trackFailures.set(trackId, { ...failure, rev: entry.rev });
      await this.#removeQuietly(written.file);
    };

    try {
      const outcome = await fetchFinishedFile(this.#options.transfer, {
        sign: async () => {
          await core.keep(trackId);
          const ticket = await core.ticket(trackId, profile);
          fetched.rev = ticket.revision;

          return ticket.url;
        },
        destination: (contentType) => {
          written.file = audioFile(trackId, fetched.rev, profile, contentType);

          return written.file === null ? null : vault.uri(written.file);
        },
        signal: stop.signal,
        sleep: this.#sleep,
      });

      await FetchOutcome.$match(outcome, {
        Fetched: async ({ bytes }) => {
          if (this.#stopped || written.file === null) return;
          const previous = this.#view.copies.get(trackId);

          const copy: StoredCopy = {
            track: entry.track,
            rev: fetched.rev,
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
          this.#trackFailures.delete(trackId);

          return this.#removeQuietly(written.file);
        },
      });
    } catch (error) {
      await fail(error instanceof Error ? error.message : "Couldn’t keep the song", true);
    } finally {
      this.#fetching.delete(trackId);
      this.#plan();
    }
  }

  async #fetchArt({ hash, url }: FetchArtStep): Promise<void> {
    const { transfer, vault, core, now } = this.#options;
    const file = artFile(hash);

    if (file === null) {
      this.#artFailures.set(hash, nextFailure(undefined, "Unusable cover", false, now()));

      return;
    }

    const stop = new AbortController();
    this.#fetchingArt.set(hash, stop);

    const fail = async (message: string): Promise<void> => {
      // A cover stopped on purpose, by Wi-Fi only or because nothing shows it, didn't fail.
      if (!stop.signal.aborted) {
        this.#artFailures.set(hash, nextFailure(this.#artFailures.get(hash), message, true, now()));
      }

      await this.#removeQuietly(file);
    };

    try {
      const result = await transfer.download({
        url: core.resolveUrl(url),
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

  #track(work: Promise<void>): Promise<void> {
    this.#work.add(work);

    void work
      .catch(() => undefined)
      .finally(() => {
        this.#work.delete(work);
      });

    return work;
  }

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

  #scheduleWake(): void {
    const now = this.#options.now();

    const canStart =
      this.#online &&
      !this.#lowSpace &&
      this.#fetching.size + this.#fetchingArt.size < MAX_TRANSFERS;

    const may = this.#mayStart();

    const retries = canStart
      ? [
          ...Array.from(this.#trackFailures, ([trackId, { retryAt }]) =>
            this.#fetching.has(trackId) || !may.song(trackId) ? null : retryAt,
          ),
          ...Array.from(this.#artFailures, ([hash, { retryAt }]) =>
            this.#fetchingArt.has(hash) || !may.art(hash) ? null : retryAt,
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
      bytes: copy.bytes + (this.#view.lyrics.get(copy.track.id)?.bytes ?? 0),
      artUri: art === undefined ? null : uri(art.file),
    };
  }

  #pinViews(): ReadonlyArray<PinView> {
    const listed = Array.from(this.#view.pins.values(), (stored) => stored.pin);

    return listed.flatMap((listedPin) => {
      const manifest = this.#manifests.get(listedPin.id);
      const stored = this.#view.pins.get(listedPin.id);

      if (manifest !== undefined) {
        const members = manifest.entries.map((entry) => ({
          trackId: entry.track.id,
          state: entry.state,
        }));

        return [{ pin: manifest.pin, members }];
      }

      // A pin saved here before its first manifest has no members yet: its songs are unknown, not
      // zero, so it reads queued rather than downloaded.
      const members = stored === undefined || stored.members.length === 0 ? null : stored.members;

      return [{ pin: stored?.pin ?? listedPin, members }];
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

    for (const lyrics of this.#view.lyrics.values()) bytes += lyrics.bytes;

    this.#snapshot = {
      ready: this.#ready,
      online: this.#online,
      lowSpace: this.#lowSpace,
      waitingForWifi: transferGate(this.#conditions, "person") === "wifi",
      pins: this.#pinViews(),
      tracks: this.#trackStates(copies),
      copies,
      usage: { tracks: copies.size, bytes, freeBytes: this.#options.vault.freeBytes() },
      lyricsQuestions: this.#questions,
    };

    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
