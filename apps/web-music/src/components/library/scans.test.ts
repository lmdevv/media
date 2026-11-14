import { NotFound } from "@media/contracts/errors";
import type { QueryState } from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import type { Scan } from "@/lib/job-progress";

import { firstActiveScan } from "./scans";

type Library = Awaited<ReturnType<PlatformSdk["core"]["libraries"]["get"]>>;

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

const library = (name: string, latest: Scan | null): QueryState<Library> => ({
  status: "success",
  data: {
    libraryId: libraryId(name),
    name,
    kind: "music",
    level: "view",
    items: 28,
    folders: null,
    scan: latest,
  },
});

const loading: QueryState<Library> = { status: "loading" };

describe("firstActiveScan", () => {
  it("is the first waiting or running scan, with its library's name", () => {
    expect(
      firstActiveScan([library("Old", scan("succeeded")), library("New", scan("running"))]),
    ).toMatchObject({ status: "running", library: "New" });
  });

  it("shows a running scan while another library still loads", () => {
    expect(firstActiveScan([loading, library("New", scan("queued"))])).toMatchObject({
      library: "New",
    });
  });

  it("is unknown while a library loads and none runs yet, and null once none does", () => {
    expect(firstActiveScan([loading, library("Old", null)])).toBeUndefined();
    expect(firstActiveScan([library("Old", scan("failed")), library("Empty", null)])).toBeNull();
    expect(firstActiveScan([])).toBeNull();
  });

  it("skips a library the person lost between the list and its read", () => {
    const lost: QueryState<Library> = {
      status: "error",
      error: new NotFound({ message: "No such library" }),
      retry: () => undefined,
    };

    expect(firstActiveScan([lost, library("Old", null)])).toBeNull();
  });
});
