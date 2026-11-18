import { Brand } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KidLimitsView, NO_LIMITS } from "./kid-limits";
import type { KidLimitsViewProps } from "./kid-limits";
import { disabledButton, loaded, noop, textOf } from "./testing";
import type { Library, LibraryId, Restrictions } from "./types";

const libraryId = Brand.nominal<LibraryId>();

const films: Library = {
  libraryId: libraryId("l1"),
  name: "Films",
  kind: "movies",
  level: "manage",
};

const songs: Library = { libraryId: libraryId("l2"), name: "Songs", kind: "music", level: "view" };

const pg: Restrictions = {
  maxMovieAge: 7,
  hideUnrated: true,
  hideExplicitMusic: false,
  libraries: [films.libraryId],
};

const props: KidLimitsViewProps = {
  saved: null,
  draft: NO_LIMITS,
  libraries: loaded([films, songs]),
  running: null,
  onChange: noop,
  onSave: noop,
  onLift: noop,
};

describe("KidLimitsView", () => {
  it("starts with no limits and nothing to save or lift", () => {
    const text = textOf(<KidLimitsView {...props} />);

    expect(text).toContain("Highest movie age");
    expect(text).toContain("Hide unrated movies");
    expect(text).toContain("Hide explicit music");
    expect(text).not.toContain("Lift all limits");
    expect(text).not.toContain("Films");
    expect(disabledButton(<KidLimitsView {...props} />, "Save limits")).toBe(true);
  });

  it("selects the saved age with its rating and lists the libraries to choose from", () => {
    const markup = renderToStaticMarkup(<KidLimitsView {...props} saved={pg} draft={pg} />);

    expect(markup).toMatch(/<option value="7" selected="">7 · PG<\/option>/u);
    expect(markup).toMatch(/<option value="chosen" selected="">/u);
    expect(textOf(<KidLimitsView {...props} saved={pg} draft={pg} />)).toContain("Films Songs");
    expect(textOf(<KidLimitsView {...props} saved={pg} draft={pg} />)).toContain("Lift all limits");
  });

  it("can save once the draft differs from what is saved", () => {
    const changed = { ...pg, hideExplicitMusic: true };

    expect(disabledButton(<KidLimitsView {...props} saved={pg} draft={pg} />, "Save limits")).toBe(
      true,
    );
    expect(
      disabledButton(<KidLimitsView {...props} saved={pg} draft={changed} />, "Save limits"),
    ).toBe(false);
  });

  it("counts chosen libraries the admin cannot see", () => {
    const hidden = { ...pg, libraries: [films.libraryId, libraryId("l9")] };
    const text = textOf(<KidLimitsView {...props} saved={hidden} draft={hidden} />);

    expect(text).toContain("Also 1 library that isn't shared with you.");
  });

  it("waits for the libraries and offers more of them", () => {
    expect(
      textOf(<KidLimitsView {...props} draft={pg} libraries={{ status: "loading" }} />),
    ).toContain("Loading libraries…");
    expect(
      textOf(<KidLimitsView {...props} draft={pg} libraries={loaded([films], true)} />),
    ).toContain("Load more");
  });

  it("disables both buttons while saving", () => {
    expect(
      disabledButton(
        <KidLimitsView {...props} saved={pg} draft={pg} running="save" />,
        "Lift all limits",
      ),
    ).toBe(true);
  });
});
