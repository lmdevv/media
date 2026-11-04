import { AgeRating, KIDS_DEFAULT_MAX_AGE } from "@media/contracts/content-rating";
import type { CreateProfileArgs, Profile } from "@media/contracts/models/profiles";
import { Schema } from "effect";

import { firstFreeAvatar } from "./avatars";

const age = Schema.decodeSync(AgeRating);

/** One choice on Maximum Rating: a US certification and the age it stands for. */
export interface RatingChoice {
  readonly label: string;
  /** The highest age rating the profile sees; null shows every title. */
  readonly maxAgeRating: AgeRating | null;
}

const RATING_CHOICES: ReadonlyArray<RatingChoice> = [
  { label: "G", maxAgeRating: age(0) },
  { label: "PG", maxAgeRating: KIDS_DEFAULT_MAX_AGE },
  { label: "PG-13", maxAgeRating: age(13) },
  { label: "R", maxAgeRating: age(17) },
  { label: "All Titles", maxAgeRating: null },
];

/** The choices a profile may pick: a kids profile always keeps a limit. */
export const ratingChoices = (kids: boolean): ReadonlyArray<RatingChoice> =>
  kids ? RATING_CHOICES.filter((choice) => choice.maxAgeRating !== null) : RATING_CHOICES;

/**
 * The label for an age limit: its certification when Paper lists one, `Ages 10+` for limits set
 * elsewhere, and `All Titles` without one.
 */
export const ratingLabel = (maxAgeRating: AgeRating | null): string =>
  RATING_CHOICES.find((choice) => choice.maxAgeRating === maxAgeRating)?.label ??
  `Ages ${String(maxAgeRating)}+`;

/** What saving does to the profile's PIN. */
export type PinChange =
  | { readonly kind: "keep" }
  | { readonly kind: "set"; readonly pin: string }
  | { readonly kind: "clear" };

/** The editor's values. */
export interface ProfileDraft {
  readonly name: string;
  readonly avatar: string;
  readonly kids: boolean;
  readonly maxAgeRating: AgeRating | null;
  readonly pin: PinChange;
}

/** A new profile: no name, the first avatar no other profile uses, all titles, no PIN. */
export const newDraft = (takenAvatars: ReadonlyArray<string>): ProfileDraft => ({
  name: "",
  avatar: firstFreeAvatar(takenAvatars),
  kids: false,
  maxAgeRating: null,
  pin: { kind: "keep" },
});

/** The draft for editing `profile`. */
export const draftFrom = (profile: Profile): ProfileDraft => ({
  name: profile.name,
  avatar: profile.avatar,
  kids: profile.kids,
  maxAgeRating: profile.maxAgeRating,
  pin: { kind: "keep" },
});

/** Turns kids on or off. Turning it on without a limit applies the kids default (PG). */
export const withKids = (draft: ProfileDraft, kids: boolean): ProfileDraft => ({
  ...draft,
  kids,
  maxAgeRating: kids && draft.maxAgeRating === null ? KIDS_DEFAULT_MAX_AGE : draft.maxAgeRating,
});

/** Whether the profile will have a PIN once the draft is saved. */
export const willHavePin = (hasPin: boolean, change: PinChange): boolean =>
  change.kind === "keep" ? hasPin : change.kind === "set";

/** The detail beside Profile PIN: `Enabled` or `Off`. */
export const pinDetail = (hasPin: boolean, change: PinChange): string =>
  willHavePin(hasPin, change) ? "Enabled" : "Off";

const MAX_NAME_LENGTH = 80;

/** Whether the draft can be saved: a name of 1 to 80 characters. */
export const canSave = (draft: ProfileDraft): boolean => {
  const name = draft.name.trim();

  return name !== "" && name.length <= MAX_NAME_LENGTH;
};

/** The arguments that create the draft's profile. */
export const createArgs = (draft: ProfileDraft): CreateProfileArgs => ({
  name: draft.name.trim(),
  avatar: draft.avatar,
  kids: draft.kids,
  maxAgeRating: draft.maxAgeRating,
});

/** The fields of `profile` the draft changes, for `profiles.update`. */
export interface ProfileChanges {
  readonly name?: string;
  readonly avatar?: string;
  readonly kids?: boolean;
  readonly maxAgeRating?: AgeRating | null;
}

/** Only the fields the draft changes, so an unchanged profile saves nothing. */
export const changesFrom = (profile: Profile, draft: ProfileDraft): ProfileChanges => {
  const changes: { -readonly [Key in keyof ProfileChanges]: ProfileChanges[Key] } = {};
  const name = draft.name.trim();

  if (name !== profile.name) changes.name = name;

  if (draft.avatar !== profile.avatar) changes.avatar = draft.avatar;

  if (draft.kids !== profile.kids) changes.kids = draft.kids;

  if (draft.maxAgeRating !== profile.maxAgeRating) changes.maxAgeRating = draft.maxAgeRating;

  return changes;
};

/** The `profiles.setPin` value saving applies, or undefined when the PIN stays as it is. */
export const pinToSave = (hasPin: boolean, change: PinChange): string | null | undefined => {
  if (change.kind === "set") return change.pin;

  return change.kind === "clear" && hasPin ? null : undefined;
};

const MAX_PROFILES = 10;

/** Whether an account with `count` profiles may add another. */
export const canAddProfile = (count: number): boolean => count < MAX_PROFILES;
