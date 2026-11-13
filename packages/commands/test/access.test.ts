import { describe, expect, it } from "vitest";

import {
  domainItem,
  downloadItem,
  downloadKinds,
  downloadResource,
  itemTypes,
} from "../src/access.ts";

describe("item and download kinds", () => {
  it("list the movies and music item types over their own tables", () => {
    const pairs = domainItem.members.flatMap((pair) =>
      pair.fields.ref.members.map(
        (ref) => `${pair.fields.domain.value} ${ref.fields.type.value} ${ref.fields.id.tableName}`,
      ),
    );

    expect(pairs).toEqual([
      "movies title titles",
      "movies episode episodes",
      "movies file mediaFiles",
      "music track tracks",
      "music album albums",
    ]);
    expect(Object.keys(itemTypes)).not.toContain("probeTrack");
  });

  it("keep a movies file and a music track for offline play, each served as itself", () => {
    expect(downloadKinds.file).toEqual({ table: "mediaFiles", serves: "file" });
    expect(
      downloadItem.members.map(
        (member) => `${member.fields.kind.value} ${member.fields.id.tableName}`,
      ),
    ).toEqual(["file mediaFiles", "track tracks"]);
    expect(downloadKinds.track).toEqual({ table: "tracks", serves: "track" });
    expect(downloadResource.fields.kind.members.map((member) => member.value)).toEqual([
      "file",
      "track",
    ]);
  });
});
