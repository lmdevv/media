import type { Paged as PagedRows } from "@media/ui/lib/pages";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { likedSongsOf } from "@/lib/use-liked-songs";

import { ListTail, Paged } from "./paged";

const retry = () => undefined;

const failedAfter = (rows: ReadonlyArray<string>): PagedRows<string> => ({
  status: "ready",
  rows,
  next: { kind: "failed", message: "The server didn't answer.", retry },
});

const offersRetry = (html: string) => {
  expect(html).toContain('role="alert"');
  expect(html).toContain("The rest of this list didn&#x27;t load. The server didn&#x27;t answer.");
  expect(html).toMatch(/<button[^>]*>Try again<\/button>/u);
};

describe("a list whose next page fails", () => {
  it("keeps the albums or artists shown and offers to load the rest again", () => {
    const html = renderToStaticMarkup(
      <Paged
        paged={failedAfter(["Cosmos", "Wanderer"])}
        renderItem={(name) => <span key={name}>{name}</span>}
        skeleton={<span>loading</span>}
        empty={<span>empty</span>}
      />,
    );

    expect(html).toContain("<span>Cosmos</span><span>Wanderer</span>");
    expect(html).not.toContain("loading");
    offersRetry(html);
  });

  it("never reads as empty when its first page held no rows it may show", () => {
    const html = renderToStaticMarkup(
      <Paged
        paged={failedAfter([])}
        renderItem={(name) => <span key={name}>{name}</span>}
        skeleton={<span>loading</span>}
        empty={<span>empty</span>}
      />,
    );

    expect(html).not.toContain("empty");
    offersRetry(html);
  });

  it("ends the songs list with the failure instead of its loading rows", () => {
    const failed = failedAfter(["Doppelgänger"]);

    if (failed.status !== "ready") throw new Error("expected a ready list");

    const html = renderToStaticMarkup(<ListTail paged={failed} skeleton={<span>loading</span>} />);

    expect(html).not.toContain("loading");
    offersRetry(html);
  });

  it("shows the songs list's loading rows and no failure while the next page loads", () => {
    const html = renderToStaticMarkup(
      <ListTail
        paged={{ status: "ready", rows: ["Wanderer"], next: { kind: "loading" } }}
        skeleton={<span>loading</span>}
      />,
    );

    expect(html).toBe("<span>loading</span>");
  });

  it("hands the liked songs the failure and its retry, and leaves them unfinished", () => {
    expect(likedSongsOf(failedAfter(["Wanderer"]))).toEqual({
      tracks: ["Wanderer"],
      done: false,
      failed: { message: "The server didn't answer.", retry },
    });
    expect(likedSongsOf({ status: "ready", rows: ["Wanderer"], next: { kind: "done" } })).toEqual({
      tracks: ["Wanderer"],
      done: true,
      failed: null,
    });
  });
});
