import { Schema, Option } from "effect";
import { Uniwind } from "uniwind";

import { readValue, writeValue } from "./secure-storage";

const KEY = "movies.appearance";

const Appearance = Schema.Literals(["dark", "light", "system"]);

/** A theme choice: `dark`, `light`, or `system` to follow iOS. */
export type Appearance = typeof Appearance.Type;

const decodeAppearance = Schema.decodeUnknownOption(Appearance);

/** The theme this device chose; dark when none. */
export const loadAppearance = (): Appearance =>
  Option.getOrElse(decodeAppearance(readValue(KEY)), () => "dark" as const);

/** Applies the remembered theme; call once at startup. */
export const applyAppearance = (): void => {
  Uniwind.setTheme(loadAppearance());
};

/** Remembers `appearance` on this device and switches the app to it at once. */
export const saveAppearance = (appearance: Appearance): void => {
  writeValue(KEY, appearance);
  Uniwind.setTheme(appearance);
};
