import { AgeRating } from "@media/contracts/content-rating";
import { Profile } from "@media/contracts/models/profiles";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  canAddProfile,
  canSave,
  changesFrom,
  createArgs,
  draftFrom,
  newDraft,
  pinDetail,
  pinToSave,
  ratingChoices,
  ratingLabel,
  withKids,
} from "./profile-draft";

const age = Schema.decodeSync(AgeRating);

const profile = (): Profile =>
  Schema.decodeSync(Profile)({
    id: "profile-1",
    name: "Alex",
    avatar: "red",
    kids: false,
    maxAgeRating: null,
    hasPin: false,
    locked: false,
    createdAt: 0,
  });

describe("profile draft", () => {
  it("labels ratings as Paper lists them", () => {
    expect(ratingLabel(null)).toBe("All Titles");
    expect(ratingLabel(age(7))).toBe("PG");
    expect(ratingLabel(age(10))).toBe("Ages 10+");
    expect(ratingChoices(true).map((choice) => choice.label)).toEqual(["G", "PG", "PG-13", "R"]);
    expect(ratingChoices(false)).toHaveLength(5);
  });

  it("gives a kids profile the default limit and keeps a chosen one", () => {
    const draft = newDraft(["red"]);

    expect(draft.avatar).toBe("blue");
    expect(withKids(draft, true).maxAgeRating).toBe(age(7));
    expect(withKids({ ...draft, maxAgeRating: age(13) }, true).maxAgeRating).toBe(age(13));
    expect(withKids(withKids(draft, true), false).maxAgeRating).toBe(age(7));
  });

  it("stops adding profiles at ten", () => {
    expect(canAddProfile(9)).toBe(true);
    expect(canAddProfile(10)).toBe(false);
  });

  it("needs a name to save", () => {
    expect(canSave(newDraft([]))).toBe(false);
    expect(canSave({ ...newDraft([]), name: "  Sam " })).toBe(true);
    expect(canSave({ ...newDraft([]), name: "x".repeat(81) })).toBe(false);
    expect(createArgs({ ...newDraft([]), name: " Sam " }).name).toBe("Sam");
  });

  it("sends only what changed", () => {
    const current = profile();

    expect(changesFrom(current, draftFrom(current))).toEqual({});
    expect(changesFrom(current, { ...draftFrom(current), name: "Alexa", kids: true })).toEqual({
      name: "Alexa",
      kids: true,
    });
  });

  it("sets, clears, or keeps the PIN", () => {
    expect(pinToSave(false, { kind: "keep" })).toBeUndefined();
    expect(pinToSave(false, { kind: "set", pin: "1234" })).toBe("1234");
    expect(pinToSave(true, { kind: "clear" })).toBeNull();
    expect(pinToSave(false, { kind: "clear" })).toBeUndefined();
    expect(pinDetail(true, { kind: "keep" })).toBe("Enabled");
    expect(pinDetail(true, { kind: "clear" })).toBe("Off");
  });
});
