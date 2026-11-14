import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RemoteLyricsView } from "./lyrics";
import { noop, textOf } from "./testing";

const view = (remote: boolean, saving = false) => (
  <RemoteLyricsView remote={remote} saving={saving} onChange={noop} />
);

describe("RemoteLyricsView", () => {
  it("names the switch and what turning it on sends to LRCLIB", () => {
    expect(textOf(view(true))).toContain(
      "Look up lyrics online Sends the title, artist, album, and length of songs without lyrics to LRCLIB.",
    );
  });

  it("shows the switch on or off as the server says", () => {
    expect(renderToStaticMarkup(view(true))).toContain('aria-checked="true"');
    expect(renderToStaticMarkup(view(false))).toContain('aria-checked="false"');
  });

  it("holds the switch while a change saves", () => {
    expect(renderToStaticMarkup(view(true, true))).toContain('aria-disabled="true"');
    expect(renderToStaticMarkup(view(true))).not.toContain('aria-disabled="true"');
  });
});
