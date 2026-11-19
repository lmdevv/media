import type { MusicCommands, QueueState, Track } from "./playback-controller";

/** A browser-only queue that can select only the songs supplied by the guest playback reads. */
export class GuestQueue<T extends Track> {
  readonly #tracks: ReadonlyArray<T>;
  readonly #changed: (state: QueueState<T>) => void;
  #current: string | null;

  constructor(tracks: ReadonlyArray<T>, changed: (state: QueueState<T>) => void) {
    this.#tracks = [...tracks];
    this.#current = tracks[0]?.id ?? null;
    this.#changed = changed;
  }

  /** The complete permitted queue, with autoplay, repeat, and shuffle off. */
  state(): QueueState<T> {
    return {
      entries: this.#tracks.map((track) => ({ itemId: track.id, autoplay: false, track })),
      complete: true,
      current: this.#current,
      shuffle: false,
      repeat: "off",
      autoplay: false,
    };
  }

  /** Details already read within the share; no catalog request is made. */
  track = async (id: string): Promise<T> => {
    const track = this.#tracks.find((song) => song.id === id);

    if (track === undefined) throw new Error("This song isn't available");

    return track;
  };

  /** Selects a permitted song without creating a household queue. */
  jump = async (id: string): Promise<void> => {
    const track = await this.track(id);
    this.#current = track.id;
    this.#changed(this.state());
  };

  /** Keeps the share's entire queue and its order even when starting a selected song. */
  play: MusicCommands["play"] = async (ids, index, shuffle) => {
    if (
      shuffle === true ||
      ids.length !== this.#tracks.length ||
      ids.some((id, at) => id !== this.#tracks[at]?.id)
    )
      throw new Error("This queue isn't available");
    const id = ids[index ?? 0];

    if (id === undefined) throw new Error("This song isn't available");
    await this.jump(id);

    return { current: id };
  };
}
