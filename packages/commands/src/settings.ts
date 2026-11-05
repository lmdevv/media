import { v } from "convex/values";
import type { GenericValidator, Infer, PropertyValidators } from "convex/values";

import type { ContentDomain } from "./scopes.ts";

/**
 * Who holds a setting's value (ADR 0019): `user` follows the person to every device, `device` is
 * the person's own value on one device, so a kid's volume on the family TV is not an adult's.
 */
const settingScopes = ["user", "device"] as const;

export type SettingScope = (typeof settingScopes)[number];

/**
 * What a value must satisfy beyond its validator. `language`: an ISO 639-1 code, two lowercase
 * letters, or null. `range`: a number from `min` to `max`, and a whole one when `whole`.
 */
type SettingCheck =
  | { readonly kind: "none" }
  | { readonly kind: "language" }
  | { readonly kind: "range"; readonly min: number; readonly max: number; readonly whole: boolean };

export interface Setting<V extends GenericValidator = GenericValidator> {
  readonly scope: SettingScope;
  /** The domains whose players read it; changing it needs `account` or one of their `play` scopes. */
  readonly domains: readonly [ContentDomain, ...ReadonlyArray<ContentDomain>];
  readonly value: V;
  readonly default: Infer<V>;
  readonly check: SettingCheck;
}

const setting = <V extends GenericValidator>(row: Setting<V>): Setting<V> => row;

const NONE = { kind: "none" } as const;

const LANGUAGE = { kind: "language" } as const;

const language = v.union(v.string(), v.null());

/** The quality a device keeps downloads at, as the `downloadQuality` setting and each download hold it. */
export const downloadQuality = v.union(v.literal("standard"), v.literal("high"));

const quality = v.union(
  v.literal("auto"),
  v.literal("original"),
  v.literal("high"),
  v.literal("standard"),
  v.literal("low"),
);

/**
 * Every setting, and whether it follows the person or stays on the device (ADR 0019, D36). A new
 * setting is one row here: the commands, their CLI flags, the stored fields, and the routing all
 * follow from it. Not settings: progress, history, likes, lists, and playlists are domain data;
 * downloaded items belong to the downloads service; a kid's restrictions are an admin's limits
 * (ADR 0005), which `explicitFilter` never weakens.
 */
const settings = {
  /** The subtitle language to show when a file has it; null leaves subtitles off. */
  subtitleLanguage: setting({
    scope: "user",
    domains: ["movies"],
    value: language,
    default: null,
    check: LANGUAGE,
  }),
  /** The audio language to choose when a file has it; null plays the file's default track. */
  audioLanguage: setting({
    scope: "user",
    domains: ["movies"],
    value: language,
    default: null,
    check: LANGUAGE,
  }),
  subtitleStyle: setting({
    scope: "user",
    domains: ["movies"],
    value: v.object({
      size: v.union(v.literal("small"), v.literal("medium"), v.literal("large")),
      color: v.union(v.literal("white"), v.literal("yellow")),
      backdrop: v.union(v.literal("none"), v.literal("shadow"), v.literal("box")),
    }),
    default: { size: "medium", color: "white", backdrop: "shadow" },
    check: NONE,
  }),
  /** Movies play the next episode; music keeps playing when the queue ends. */
  autoplay: setting({
    scope: "user",
    domains: ["movies", "music"],
    value: v.boolean(),
    default: true,
    check: NONE,
  }),
  /** Hides explicit tracks. A kid's `hideExplicitMusic` hides them whatever this says. */
  explicitFilter: setting({
    scope: "user",
    domains: ["music"],
    value: v.boolean(),
    default: false,
    check: NONE,
  }),
  /** Seconds two tracks overlap; 0 is off. */
  crossfade: setting({
    scope: "user",
    domains: ["music"],
    value: v.number(),
    default: 0,
    check: { kind: "range", min: 0, max: 12, whole: true },
  }),
  gapless: setting({
    scope: "user",
    domains: ["music"],
    value: v.boolean(),
    default: true,
    check: NONE,
  }),
  /**
   * A tier each domain maps to its own presets: `auto` adapts to the connection, `original` never
   * transcodes, and movies play `high`, `standard`, and `low` at 1080p, 720p, and 480p.
   */
  streamQuality: setting({
    scope: "device",
    domains: ["movies", "music"],
    value: quality,
    default: "auto",
    check: NONE,
  }),
  downloadQuality: setting({
    scope: "device",
    domains: ["movies", "music"],
    value: downloadQuality,
    default: "standard",
    check: NONE,
  }),
  volume: setting({
    scope: "device",
    domains: ["movies", "music"],
    value: v.number(),
    default: 1,
    check: { kind: "range", min: 0, max: 1, whole: false },
  }),
} as const;

export type SettingName = keyof typeof settings;

const isSettingName = (name: string): name is SettingName => Object.hasOwn(settings, name);

/** Each setting's name and row, in table order. */
export const settingRows: ReadonlyArray<readonly [SettingName, Setting]> = Object.entries(
  settings,
).flatMap(([name, row]) => (isSettingName(name) ? [[name, row] as const] : []));

/**
 * The settings of `scope` as Convex fields: `required` for the values `get` shows, `optional` for
 * what `set` takes and a stored row holds. `all` takes every setting.
 */
export const settingFields = (
  scope: SettingScope | "all",
  presence: "required" | "optional",
): PropertyValidators =>
  Object.fromEntries(
    settingRows.flatMap(([name, row]) =>
      scope === "all" || row.scope === scope
        ? [[name, presence === "optional" ? v.optional(row.value) : row.value] as const]
        : [],
    ),
  );
