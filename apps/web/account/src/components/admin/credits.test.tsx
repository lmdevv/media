import { Brand } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CorrectionChoices,
  CorrectionsView,
  CreditsView,
  correctionCall,
  creditFacts,
} from "./credits";
import type { Choosing, CorrectionCommands } from "./credits";
import type { LibraryState } from "./library";
import type { Paged } from "@media/ui/lib/pages";
import { loaded, noop, textOf } from "./testing";
import type { Correction, CorrectionMode, Credit, LibraryDetail, LibraryId } from "./types";

const libraryId = Brand.nominal<LibraryId>();

const songs: LibraryDetail = {
  libraryId: libraryId("l1"),
  name: "Songs",
  kind: "music",
  level: "manage",
  items: 40,
  folders: ["/srv/music"],
  scan: null,
};

const page = (state: LibraryState) => (
  <CreditsView
    state={state}
    back={<a href="#libraries">Libraries</a>}
    renderLibraryCrumb={(library) => <a href="#library">{library.name}</a>}
    corrections={<p>corrections part</p>}
  />
);

describe("CreditsView", () => {
  it("shows a manager of a music library its corrections under the library's breadcrumb", () => {
    const text = textOf(page({ kind: "ready", library: songs }));

    expect(text).toContain("Libraries Songs Artist credits");
    expect(text).toContain("corrections part");
  });

  it("tells anyone else why there is nothing to correct", () => {
    for (const level of ["edit", "view"] as const) {
      const text = textOf(page({ kind: "ready", library: { ...songs, level } }));

      expect(text).toContain("Only a manager of this library can correct its artist credits.");
      expect(text).not.toContain("corrections part");
    }

    const films = textOf(page({ kind: "ready", library: { ...songs, kind: "movies" } }));

    expect(films).toContain("Only music libraries have artist credits.");
    expect(films).not.toContain("corrections part");
  });

  it("shows a missing library and a failure", () => {
    expect(textOf(page({ kind: "missing" }))).toContain(
      "Artist credits This library doesn't exist, or it isn't shared with you.",
    );
    expect(textOf(page({ kind: "failed", message: "Offline", retry: noop }))).toContain(
      "Offline Try again",
    );
  });
});

const mora: Credit = {
  name: "Mora & JHAYCO",
  artists: ["Mora", "JHAYCO"],
  override: null,
  uses: 3,
};

const wuki: Credit = {
  name: "Wuki & Lee Foss",
  artists: ["Wuki & Lee Foss"],
  override: "together",
  uses: 1,
};

describe("creditFacts", () => {
  it("says what a credit credits now, how many songs and albums name it, and its correction", () => {
    expect(creditFacts(mora)).toBe("Credits Mora and JHAYCO · 3 songs and albums");
    expect(creditFacts(wuki)).toBe("One artist · 1 song or album · Corrected: kept together");
    expect(
      creditFacts({
        name: "Revol, Ozuna & Cosculluela",
        artists: ["Revol", "Ozuna", "Cosculluela"],
        override: "split",
        uses: 2,
      }),
    ).toBe("Credits Revol, Ozuna, and Cosculluela · 2 songs and albums · Corrected: split");
  });

  it("calls a credit that resolves to its own name in another case one artist", () => {
    expect(creditFacts({ ...wuki, artists: ["wuki & lee foss"], override: null })).toBe(
      "One artist · 1 song or album",
    );
  });
});

/** `count` corrections, the first of them Wuki & Lee Foss's. */
const correctionsOf = (count: number): ReadonlyArray<Correction> =>
  Array.from({ length: count }, (_, index) =>
    index === 0
      ? { name: wuki.name, mode: "together" }
      : { name: `Artist ${index} & Guest`, mode: "split" },
  );

const view = ({
  credits = loaded([mora, wuki]),
  corrections = loaded(correctionsOf(1)),
  running = null,
  choosing = null,
}: {
  readonly credits?: Paged<Credit>;
  readonly corrections?: Paged<Correction>;
  readonly running?: string | null;
  readonly choosing?: Choosing | null;
}) => (
  <CorrectionsView
    credits={credits}
    corrections={corrections}
    running={running}
    choosing={choosing}
    onChoose={noop}
    onSave={noop}
    onRemove={noop}
  />
);

/** The markup of the item named `name` in the list named `list`, which must hold it. */
const rowOf = (html: string, list: string, name: string): string => {
  const start = html.indexOf(`<ul aria-label="${list}"`);
  const items = html.slice(start, html.indexOf("</ul>", start));
  const label = name.replaceAll("&", "&amp;");
  const row = items.split("</li>").find((item) => item.includes(`<li aria-label="${label}"`));

  expect(start, `the ${list} list`).toBeGreaterThanOrEqual(0);
  expect(row, `the ${name} row`).toBeDefined();

  return row ?? "";
};

/** Whether `markup` draws the button labeled `label` disabled. */
const disabledIn = (markup: string, label: string): boolean =>
  new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`, "u").test(markup);

describe("CorrectionsView", () => {
  it("lists each correction with Remove correction, and each credit with Correct", () => {
    const text = textOf(view({}));

    expect(text).toContain(
      "Lar splits a credit such as “Mora & JHAYCO” into its artists once one of them has songs of their own.",
    );
    expect(text).toContain("1 of 256 corrections Wuki & Lee Foss Kept together Remove correction");
    expect(text).toContain("Mora & JHAYCO Credits Mora and JHAYCO · 3 songs and albums Correct");
    expect(text).toContain(
      "Wuki & Lee Foss One artist · 1 song or album · Corrected: kept together Correct",
    );
  });

  it("names each row by its credit", () => {
    const html = renderToStaticMarkup(view({}));

    expect(rowOf(html, "Corrections", wuki.name)).toContain("Remove correction");
    expect(rowOf(html, "Credits", mora.name)).toContain("Correct");
    expect(rowOf(html, "Credits", wuki.name)).toContain("Correct");
  });

  it("says when nothing is corrected and no credit names several artists", () => {
    const text = textOf(view({ credits: loaded([]), corrections: loaded([]) }));

    expect(text).toContain("0 of 256 corrections No corrections yet.");
    expect(text).toContain("No credit in this library names several artists.");
  });

  it("counts the corrections only once every page is loaded", () => {
    expect(textOf(view({ corrections: loaded(correctionsOf(3), true) }))).not.toContain(
      "of 256 corrections",
    );
  });

  it("offers Correct on every credit below the limit", () => {
    const below = view({ corrections: loaded(correctionsOf(255)) });

    expect(textOf(below)).not.toContain("A library keeps at most");
    expect(disabledIn(rowOf(renderToStaticMarkup(below), "Credits", mora.name), "Correct")).toBe(
      false,
    );
  });

  it("at the limit, holds Correct on a credit without a correction and says why", () => {
    const full = view({ corrections: loaded(correctionsOf(256)) });
    const html = renderToStaticMarkup(full);
    const moraRow = rowOf(html, "Credits", mora.name);

    expect(textOf(full)).toContain("256 of 256 corrections");
    expect(textOf(full)).toContain(
      "A library keeps at most 256 corrections. Remove one to correct another credit.",
    );
    expect(disabledIn(moraRow, "Correct")).toBe(true);
    expect(moraRow).toContain("aria-describedby=");
    expect(disabledIn(rowOf(html, "Credits", wuki.name), "Correct")).toBe(false);
    expect(disabledIn(rowOf(html, "Corrections", wuki.name), "Remove correction")).toBe(false);
  });

  it("holds every button while a correction saves", () => {
    const html = renderToStaticMarkup(view({ running: mora.name }));

    expect(disabledIn(rowOf(html, "Credits", mora.name), "Correct")).toBe(true);
    expect(disabledIn(rowOf(html, "Credits", wuki.name), "Correct")).toBe(true);
    expect(disabledIn(rowOf(html, "Corrections", wuki.name), "Remove correction")).toBe(true);
  });
});

/** Whether each radio of the choices is checked, Keep together first, for `mode`. */
const checked = (mode: CorrectionMode | null): ReadonlyArray<string | undefined> =>
  [
    ...renderToStaticMarkup(<CorrectionChoices mode={mode} onChange={noop} />).matchAll(
      /role="radio"[^>]*aria-checked="(true|false)"/gu,
    ),
  ].map((match) => match[1]);

describe("CorrectionChoices", () => {
  it("names each radio by its label alone and describes what it does", () => {
    const html = renderToStaticMarkup(<CorrectionChoices mode={null} onChange={noop} />);

    expect(textOf(<CorrectionChoices mode={null} onChange={noop} />)).toContain(
      "Keep together One artist, also where it appears inside a longer credit. Split Each name is an artist of its own, even with no songs of their own.",
    );

    for (const label of ["Keep together", "Split"]) {
      const labelId = new RegExp(`id="([^"]+)"[^>]*>${label}</span>`, "u").exec(html)?.[1];

      expect(labelId).toBeDefined();
      expect(html).toContain(`aria-labelledby="${labelId ?? ""}"`);
    }
  });

  it("checks the credit's correction, and nothing while it has none", () => {
    expect(checked("together")).toEqual(["true", "false"]);
    expect(checked("split")).toEqual(["false", "true"]);
    expect(checked(null)).toEqual(["false", "false"]);
  });
});

/** Credit commands that record each call and succeed. */
const recordingCommands = () => {
  const calls: Array<{ readonly command: string; readonly args: unknown }> = [];

  const commands: CorrectionCommands = {
    setOverride: (args) => {
      calls.push({ command: "setOverride", args });

      return Promise.resolve(null);
    },
    removeOverride: (args) => {
      calls.push({ command: "removeOverride", args });

      return Promise.resolve(null);
    },
  };

  return { calls, commands };
};

describe("correctionCall", () => {
  it("sets a correction through setOverride once called, and says it saved", async () => {
    const { calls, commands } = recordingCommands();

    const { call, success } = correctionCall(commands, libraryId("l1"), {
      kind: "set",
      name: mora.name,
      mode: "together",
    });

    expect(calls).toEqual([]);
    await expect(call()).resolves.toBeNull();
    expect(calls).toEqual([
      {
        command: "setOverride",
        args: { libraryId: "l1", name: "Mora & JHAYCO", mode: "together" },
      },
    ]);
    expect(success).toBe("Correction saved");
  });

  it("removes a correction through removeOverride, and says it is removed", async () => {
    const { calls, commands } = recordingCommands();

    const { call, success } = correctionCall(commands, libraryId("l1"), {
      kind: "remove",
      name: wuki.name,
    });

    await call();
    expect(calls).toEqual([
      { command: "removeOverride", args: { libraryId: "l1", name: "Wuki & Lee Foss" } },
    ]);
    expect(success).toBe("Correction removed");
  });
});
