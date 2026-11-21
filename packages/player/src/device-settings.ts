import type { PlatformSdk } from "@media/sdk/promise";

import { settingOfQuality } from "./stream-quality";
import type { StreamQuality } from "./stream-quality";

/** Wait this long after the last volume change before saving it. */
const VOLUME_SAVE_MS = 500;

type SaveSettings = PlatformSdk["core"]["settings"]["set"];

type SettingsPatch = Parameters<SaveSettings>[0];

/**
 * Saves the settings chosen on this browser to the core while the core keeps settings for this
 * device (D36). A volume is saved once it stops changing, and the one chosen here stands over the
 * core's answers until the core answers with it.
 */
export class DeviceSettingsSaves {
  readonly #save: SaveSettings;
  #keeps: boolean;
  #unsavedVolume: number | null = null;
  #volumeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(save: SaveSettings, keeps: boolean) {
    this.#save = save;
    this.#keeps = keeps;
  }

  /** Whether the core keeps settings for this device, read when a change is saved. */
  keepsDevice(keeps: boolean): void {
    this.#keeps = keeps;
  }

  quality(quality: StreamQuality): void {
    this.#send({ streamQuality: settingOfQuality(quality) });
  }

  volume(volume: number): void {
    if (this.#keeps) this.#unsavedVolume = volume;
    clearTimeout(this.#volumeTimer);
    this.#volumeTimer = setTimeout(() => {
      this.#send({ volume });
    }, VOLUME_SAVE_MS);
  }

  /** The volume to play when the core answers with `saved`: the newest one chosen here, until saved. */
  volumeOf(saved: number): number {
    if (this.#unsavedVolume === saved) this.#unsavedVolume = null;

    return this.#unsavedVolume ?? saved;
  }

  #send(patch: SettingsPatch): void {
    if (this.#keeps) void this.#save(patch).catch(() => undefined);
  }
}
