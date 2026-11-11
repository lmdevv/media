import type { Appearance } from "@/lib/appearance";
import type { PreferenceOption } from "@/lib/preferences";

/** System, Light, and Dark. */
export const APPEARANCE_OPTIONS: ReadonlyArray<PreferenceOption<Appearance>> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
