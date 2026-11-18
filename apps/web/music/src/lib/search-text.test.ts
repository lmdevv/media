import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { foldSearchText } from "./search-text";

describe("foldSearchText", () => {
  it("strips accents and case from names people search for", () => {
    expect(foldSearchText("Doppelgänger")).toBe("doppelganger");
    expect(foldSearchText("Beyoncé")).toBe("beyonce");
    expect(foldSearchText("Sigur Rós")).toBe("sigur ros");
    expect(foldSearchText("Mötley Crüe")).toBe("motley crue");
    expect(foldSearchText("Ñandú")).toBe("nandu");
    expect(foldSearchText("Ёлка")).toBe("елка");
  });

  it("spells out letters that have no separable accent", () => {
    expect(foldSearchText("Straße")).toBe("strasse");
    expect(foldSearchText("STRAẞE")).toBe("strasse");
    expect(foldSearchText("Ærø")).toBe("aero");
    expect(foldSearchText("Œuvre")).toBe("oeuvre");
    expect(foldSearchText("Łódź")).toBe("lodz");
    expect(foldSearchText("Søren Þór")).toBe("soren thor");
    expect(foldSearchText("Ðorđe")).toBe("dorde");
    expect(foldSearchText("İstanbul ılık")).toBe("istanbul ilik");
  });

  it("keeps scripts whose marks are part of the letter", () => {
    expect(foldSearchText("ガンダム")).toBe("ガンダム");
    expect(foldSearchText("한국어")).toBe("한국어");
    expect(foldSearchText("हिन्दी")).toBe("हिन्दी");
  });

  it("leaves lowercase ASCII unchanged", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9 .,'&!?()-]*$/u), (text) => {
        expect(foldSearchText(text)).toBe(text);
      }),
    );
  });

  it("is idempotent, so folded stored text and a folded query agree", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (text) => {
        const folded = foldSearchText(text);

        expect(foldSearchText(folded)).toBe(folded);
      }),
    );
  });

  it("folds composed and decomposed spellings of the same text alike", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (text) => {
        expect(foldSearchText(text.normalize("NFD"))).toBe(foldSearchText(text.normalize("NFC")));
      }),
    );
  });

  it("never leaves an accent mark behind", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (text) => {
        expect(foldSearchText(text)).not.toMatch(/[\u0300-\u036F]/u);
      }),
    );
  });
});
