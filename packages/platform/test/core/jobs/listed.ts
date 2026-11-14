import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { SignedIn } from "../../sign-in";

/** The pages a search for one job reads before it gives up, newest first. */
const PAGES_SEARCHED = 20;

type Status = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** The `core.jobs.list` row of `jobId` as `client` sees it, searching newest first; undefined when absent. */
export const listedJob = async (client: SignedIn["client"], jobId: Id<"jobs">, status?: Status) => {
  const search = async (cursor: string | null, pages: number) => {
    const paginationOpts = { numItems: 100, cursor };

    const page = await (status === undefined
      ? client.query(api.core.jobs.list, { paginationOpts })
      : client.query(api.core.jobs.list, { status, paginationOpts }));

    const found = page.page.find((row) => row.jobId === jobId);

    if (found !== undefined || page.isDone || pages >= PAGES_SEARCHED) return found;

    return search(page.continueCursor, pages + 1);
  };

  return search(null, 1);
};
