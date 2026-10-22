/**
 * Light, dark, or following the system (F03). The choice is kept on this device and applied
 * before the first frame, so the app never flashes the other theme.
 */
import { Option, Schema } from "effect";
import { Uniwind } from "uniwind";

import { readValue, writeValue } from "./secure-storage";

const KEY = "music.appearance";

/** A theme choice: `light`, `dark`, or `system` to follow iOS. */
export const Appearance = Schema.Literals(["light", "dark", "system"]);

/** A theme choice: `light`, `dark`, or `system` to follow iOS. */
export type Appearance = typeof Appearance.Type;

const decodeAppearance = Schema.decodeUnknownOption(Appearance);

/** The theme this device chose; the system's when none. */
export const loadAppearance = (): Appearance =>
  Option.getOrElse(decodeAppearance(readValue(KEY)), () => "system" as const);

/** Applies the remembered theme; the root layout calls it once, before the first render. */
export const applyAppearance = (): void => {
  Uniwind.setTheme(loadAppearance());
};

/** Remembers `appearance` on this device and switches the app to it at once. */
export const saveAppearance = (appearance: Appearance): void => {
  writeValue(KEY, appearance);
  Uniwind.setTheme(appearance);
};
