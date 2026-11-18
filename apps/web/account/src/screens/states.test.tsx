import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BlankPage, UnreachableScreen } from "./states";

describe("states", () => {
  it("shows a busy blank page while waiting", () => {
    expect(renderToStaticMarkup(<BlankPage />)).toContain('aria-busy="true"');
  });

  it("offers a retry when the server does not answer", () => {
    const html = renderToStaticMarkup(<UnreachableScreen retry={() => undefined} />);

    expect(html).toContain("Can&#x27;t reach the server.");
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/u);
  });
});
