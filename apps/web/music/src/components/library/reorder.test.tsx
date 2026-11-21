import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReorderHandle } from "./reorder";

/** The text of the element `id` names, as a screen reader reads it for a description. */
const textOf = (html: string, id: string): string | undefined =>
  html
    .split(`id="${id}"`)[1]
    ?.split("</span>")[0]
    ?.replace(/^[^>]*>/u, "")
    .replaceAll(/<!--.*?-->/gu, "");

describe("ReorderHandle", () => {
  it("tells screen readers the entry's place and how to move it", () => {
    const html = renderToStaticMarkup(
      <ReorderHandle label="Cosmos" index={1} count={5} reorder={{ moveBy: () => undefined }} />,
    );

    const describedBy = /aria-describedby="([^"]+)"/u.exec(html)?.[1] ?? "";

    expect(html).toContain('aria-label="Move Cosmos"');
    expect(textOf(html, describedBy)).toBe(
      "Position 2 of 5. Press the up or down arrow to move it.",
    );
  });
});
