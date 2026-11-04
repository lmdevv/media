import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import type { issuePersonalTicket } from "../../convex/core/tickets";

const convexRoot = fileURLToPath(new URL("../../convex", import.meta.url));

const sources = (folder: string): ReadonlyArray<string> =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);

    if (entry.isDirectory()) return entry.name === "_generated" ? [] : sources(path);

    return entry.name.endsWith(".ts") ? [path] : [];
  });

const READS_TICKET_KEYS = /MEDIA_TICKET_KEYS|TICKET_KEYS_SETTING|loadTicketKeyRing/u;

type TicketContext = Parameters<typeof issuePersonalTicket>[0];

const queryContextIssues: Pick<QueryCtx, "db"> extends TicketContext ? true : false = false;

const mutationContextIssues: Pick<MutationCtx, "db"> extends TicketContext ? true : false = true;

describe("the ticket keys", () => {
  it("are read only by the core's ticket functions", () => {
    const readers = sources(convexRoot)
      .filter((path) => READS_TICKET_KEYS.test(readFileSync(path, "utf8")))
      .map((path) => relative(convexRoot, path));

    expect(readers).toEqual(["core/tickets.ts"]);
  });

  it("sign personal tickets only from a mutation", () => {
    expect([queryContextIssues, mutationContextIssues]).toEqual([false, true]);
  });
});
