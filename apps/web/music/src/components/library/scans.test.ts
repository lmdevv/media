import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import type { Scan } from "@/lib/job-progress";

import { firstActiveScan } from "./scans";

type Library = Awaited<ReturnType<PlatformSdk["core"]["libraries"]["list"]>>["page"][number];

const libraryId = Brand.nominal<Library["libraryId"]>();

const jobId = Brand.nominal<Scan["jobId"]>();

const scan = (status: Scan["status"]): Scan => ({
  jobId: jobId("j1"),
  status,
  done: 3,
  total: 28,
  error: null,
  message: null,
  startedAt: 0,
  attempt: 1,
  canceling: false,
  finishedAt: null,
});

const library = (name: string, latest: Scan | null, kind: Library["kind"] = "music"): Library => ({
  libraryId: libraryId(name),
  name,
  kind,
  level: "view",
  scan: latest,
});

describe("firstActiveScan", () => {
  it("is the first waiting or running scan of a music library, with its name", () => {
    expect(
      firstActiveScan([
        library("Old", scan("succeeded")),
        library("Films", scan("running"), "movies"),
        library("New", scan("queued")),
        library("Newer", scan("running")),
      ]),
    ).toMatchObject({ status: "queued", library: "New" });
  });

  it("is null when no music library scans", () => {
    expect(firstActiveScan([library("Old", scan("failed")), library("Empty", null)])).toBeNull();
    expect(firstActiveScan([])).toBeNull();
  });

  it("counts a row its server sent without a scan as not scanning", () => {
    expect(
      firstActiveScan([{ libraryId: libraryId("Old"), name: "Old", kind: "music", level: "view" }]),
    ).toBeNull();
  });
});
