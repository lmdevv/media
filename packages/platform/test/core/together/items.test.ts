import { describe, expect, expectTypeOf, it } from "vitest";

import { domainItem, itemTypes } from "../../../commands/access";
import type { DomainItem } from "../../../commands/access";
import type { Id } from "../../../convex/_generated/dataModel";

describe("typed item references", () => {
  it("pair each domain only with its own item types", () => {
    expectTypeOf<{
      domain: "movies";
      ref: { type: "title"; id: Id<"titles"> };
    }>().toExtend<DomainItem>();
    expectTypeOf<{
      domain: "movies";
      ref: { type: "episode"; id: Id<"episodes"> };
    }>().toExtend<DomainItem>();
    expectTypeOf<{
      domain: "movies";
      ref: { type: "file"; id: Id<"mediaFiles"> };
    }>().toExtend<DomainItem>();
    expectTypeOf<{
      domain: "movies";
      ref: { type: "probeTrack"; id: Id<"probeItems"> };
    }>().not.toExtend<DomainItem>();
    expectTypeOf<{
      domain: "music";
      ref: { type: "title"; id: Id<"titles"> };
    }>().not.toExtend<DomainItem>();
    expectTypeOf<{
      domain: "movies";
      ref: { type: "title"; id: Id<"probeItems"> };
    }>().not.toExtend<DomainItem>();
  });

  it("accept on the wire exactly the item types each domain lists", () => {
    const accepted = domainItem.members.flatMap((pair) =>
      pair.fields.ref.members.map(
        (ref) => `${pair.fields.domain.value} ${ref.fields.type.value} ${ref.fields.id.tableName}`,
      ),
    );

    const listed = Object.entries(itemTypes).map(
      ([type, entry]) => `${entry.domain} ${type} ${entry.table}`,
    );

    expect(new Set(accepted)).toEqual(new Set(listed));
    expect(accepted).toHaveLength(listed.length);
  });
});
