import { describe, expect, it } from "vitest";

import {
  domainItem,
  downloadItem,
  downloadKinds,
  downloadResource,
  itemTypes,
} from "../src/access.ts";

describe("item and download kinds", () => {
  it("list the movies item types over movies' own tables, and the music stand-in", () => {
    const pairs = domainItem.members.flatMap((pair) =>
      pair.fields.ref.members.map(
        (ref) => `${pair.fields.domain.value} ${ref.fields.type.value} ${ref.fields.id.tableName}`,
      ),
    );

    expect(pairs).toEqual([
      "movies title titles",
      "movies episode episodes",
      "movies file mediaFiles",
      "music probeTrack probeItems",
    ]);
    expect(Object.keys(itemTypes)).not.toContain("probeMovie");
  });

  it("keep a movies file for offline play, served as a file", () => {
    expect(downloadKinds.file).toEqual({ table: "mediaFiles", serves: "file" });
    expect(
      downloadItem.members.map(
        (member) => `${member.fields.kind.value} ${member.fields.id.tableName}`,
      ),
    ).toEqual(["file mediaFiles", "probe probeItems"]);
    expect(downloadResource.fields.kind.members.map((member) => member.value)).toEqual(["file"]);
  });
});
