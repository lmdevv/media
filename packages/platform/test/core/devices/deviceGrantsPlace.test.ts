import type { FunctionArgs } from "convex/server";
import type { GenericValidator } from "convex/values";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { internal } from "../../../convex/_generated/api";
import { placeArgs } from "../../../convex/core/devices/deviceGrants";

type PlaceArgs = FunctionArgs<typeof internal.core.devices.deviceGrants.place>;

/** The path of every string a validator accepts, so a field that could carry a code shows. */
const stringPaths = (validator: GenericValidator, path: string): ReadonlyArray<string> => {
  if (validator.kind === "string") return [path];

  if (validator.kind === "object") {
    return Object.entries(validator.fields).flatMap(([field, inner]) =>
      stringPaths(inner, path === "" ? field : `${path}.${field}`),
    );
  }

  if (validator.kind === "union") {
    return validator.members.flatMap((member) => stringPaths(member, path));
  }

  return [];
};

describe("placing a device grant", () => {
  it("takes the grant the device holds as its row id and hash, never the code", () => {
    expectTypeOf<PlaceArgs["held"]>().toEqualTypeOf<{
      grantId: string;
      secretHash: string;
    } | null>();
    expect(stringPaths(placeArgs, "").toSorted()).toEqual([
      "held.grantId",
      "held.secretHash",
      "name",
      "secretHash",
    ]);
  });
});
