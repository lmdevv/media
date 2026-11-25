import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MAX_CREDIT_PARTS,
  creditKey,
  creditParts,
  creditRuns,
  distinctNames,
  featuredCredits,
  isCombined,
  joinCreditNames,
  resolveCredit,
  staysWhole,
} from "./artist-credits";
import type { CreditEvidence, CreditOverride } from "./artist-credits";

/** Evidence from names known on their own, runs kept together, and a manager's corrections. */
const evidenceOf = (
  known: ReadonlyArray<string>,
  kept: ReadonlyArray<string> = [],
  overrides: ReadonlyArray<readonly [string, CreditOverride]> = [],
): CreditEvidence => {
  const knownKeys = new Set(known.map(creditKey));
  const keptKeys = new Set(kept.map(creditKey));
  const corrected = new Map(overrides.map(([name, mode]) => [creditKey(name), mode]));

  return {
    known: (name) => knownKeys.has(creditKey(name)),
    kept: (name) => keptKeys.has(creditKey(name)) || corrected.get(creditKey(name)) === "together",
    override: (name) => corrected.get(creditKey(name)) ?? null,
  };
};

const names = (text: string) => creditParts(text).map((part) => part.name);

describe("creditParts", () => {
  it("splits on commas, ampersands, and feat., ft., or featuring in any case", () => {
    expect(names("Mora & JHAYCO")).toEqual(["Mora", "JHAYCO"]);
    expect(names("Mora, Bad Bunny & Sech")).toEqual(["Mora", "Bad Bunny", "Sech"]);
    expect(names("Fred again.. feat. Kodak Black")).toEqual(["Fred again..", "Kodak Black"]);
    expect(names("A FT. B Featuring C")).toEqual(["A", "B", "C"]);
    expect(names("Rampa, Adam Port & &ME")).toEqual(["Rampa", "Adam Port", "&ME"]);
    expect(names("HUGEL & SOLTO (FR)")).toEqual(["HUGEL", "SOLTO (FR)"]);
  });

  it("never splits on y, x, X, and, or a slash", () => {
    for (const act of [
      "Alexis y Fido",
      "Fruko y Sus Tesos",
      "Gigolo y La Exce",
      "Jon Z X Ele A",
      "Jon Z x Ele A",
      "Simon and Garfunkel",
      "AC/DC",
    ]) {
      expect(names(act)).toEqual([act]);
      expect(isCombined(act)).toBe(false);
    }
  });

  it("keeps each part's place in the string, so a run keeps its own separators", () => {
    const text = "Bad Bunny & Zion & Lennox";

    expect(creditParts(text).map((part) => text.slice(part.start, part.end))).toEqual(names(text));
    expect(creditRuns(text, 4)).toEqual(["Bad Bunny & Zion", "Zion & Lennox"]);
    expect(creditRuns("A, B & C, D", 2)).toEqual(["A, B", "B & C", "C, D"]);
  });

  it("finds every part again in the string", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        for (const part of creditParts(text)) {
          expect(text.slice(part.start, part.end)).toBe(part.name);
          expect(part.name).toBe(part.name.trim());
          expect(part.name.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});

describe("featuredCredits", () => {
  it("reads feat., ft., featuring, and with in round or square brackets", () => {
    expect(featuredCredits("TOA (feat. Young Miko)")).toEqual(["Young Miko"]);
    expect(featuredCredits("El Perdón (with Enrique Iglesias)")).toEqual(["Enrique Iglesias"]);
    expect(featuredCredits("Song [Feat. A & B]")).toEqual(["A & B"]);
    expect(featuredCredits("Song (ft. A) [featuring B]")).toEqual(["A", "B"]);
    expect(featuredCredits("Si Es Trucho Es Trucho (feat. Farruko & El Alfa) - Remix")).toEqual([
      "Farruko & El Alfa",
    ]);
    expect(featuredCredits("Plain Title (Remastered 2024)")).toEqual([]);
    expect(featuredCredits("Feat. Nobody")).toEqual([]);
  });
});

describe("resolveCredit", () => {
  it("splits a combined string only when one of its parts is known on its own", () => {
    expect(resolveCredit("Mora & JHAYCO", evidenceOf(["Mora"]))).toEqual(["Mora", "JHAYCO"]);
    expect(resolveCredit("Wuki & Lee Foss", evidenceOf([]))).toEqual(["Wuki & Lee Foss"]);
    expect(resolveCredit("Mumford & Sons", evidenceOf(["Mumford & Sons"]))).toEqual([
      "Mumford & Sons",
    ]);
    expect(resolveCredit("Revol, Ozuna & Cosculluela", evidenceOf(["Ozuna"]))).toEqual([
      "Revol",
      "Ozuna",
      "Cosculluela",
    ]);
  });

  it("drops a later spelling of a name already named", () => {
    expect(resolveCredit("Imael Angel, Imael Angel", evidenceOf(["Imael Angel"]))).toEqual([
      "Imael Angel",
    ]);
    expect(resolveCredit("A & a", evidenceOf(["a"]))).toEqual(["A"]);
  });

  it("keeps a run that is a whole credit in the library together and counts it as known", () => {
    const text = "CA7RIEL & Paco Amoroso, PinkPantheress";

    expect(resolveCredit(text, evidenceOf([], ["CA7RIEL & Paco Amoroso"]))).toEqual([
      "CA7RIEL & Paco Amoroso",
      "PinkPantheress",
    ]);
    expect(resolveCredit("Bad Bunny & Zion & Lennox", evidenceOf(["Bad Bunny"]))).toEqual([
      "Bad Bunny",
      "Zion",
      "Lennox",
    ]);
    expect(
      resolveCredit("Bad Bunny & Zion & Lennox", evidenceOf(["Bad Bunny"], ["Zion & Lennox"])),
    ).toEqual(["Bad Bunny", "Zion & Lennox"]);
  });

  it("follows a manager's together and split over the evidence", () => {
    expect(
      resolveCredit("Chino & Nacho", evidenceOf(["Nacho"], [], [["Chino & Nacho", "together"]])),
    ).toEqual(["Chino & Nacho"]);
    expect(
      resolveCredit("Wuki & Lee Foss", evidenceOf([], [], [["Wuki & Lee Foss", "split"]])),
    ).toEqual(["Wuki", "Lee Foss"]);

    const text = "Tame Impala, SZA, King Gizzard & the Lizard Wizard";

    expect(resolveCredit(text, evidenceOf([], [], [[text, "split"]]))).toEqual([
      "Tame Impala",
      "SZA",
      "King Gizzard",
      "the Lizard Wizard",
    ]);
    expect(
      resolveCredit(text, evidenceOf([], [], [["King Gizzard & the Lizard Wizard", "together"]])),
    ).toEqual(["Tame Impala", "SZA", "King Gizzard & the Lizard Wizard"]);
  });

  it("keeps a string of more parts than it splits whole, and a string without separators", () => {
    const many = Array.from({ length: MAX_CREDIT_PARTS + 1 }, (_, n) => `A${n}`).join(", ");

    expect(resolveCredit(many, evidenceOf(["A0"], [], [[many, "split"]]))).toEqual([many]);
    expect(resolveCredit("  Bad Bunny ", evidenceOf(["Bad Bunny"]))).toEqual(["Bad Bunny"]);
    expect(resolveCredit("Alexis y Fido", evidenceOf(["Alexis"]))).toEqual(["Alexis y Fido"]);
  });

  it("answers distinct names, all of them parts or runs of the string, the same way every time", () => {
    const part = fc.constantFrom("A", "B", "C", "D", "a", "Bad Bunny", "&ME");
    const separator = fc.constantFrom(", ", " & ", " feat. ", " y ");

    const credit: fc.Arbitrary<string> = fc
      .tuple(part, fc.array(fc.tuple(separator, part), { maxLength: 5 }))
      .map(([first, rest]) =>
        rest.reduce<string>((text, [sep, next]) => `${text}${sep}${next}`, first),
      );

    fc.assert(
      fc.property(credit, fc.subarray(["A", "B", "Bad Bunny", "&ME"]), (text, known) => {
        const evidence = evidenceOf(known);
        const artists = resolveCredit(text, evidence);
        const keys = artists.map(creditKey);

        expect(new Set(keys).size).toBe(keys.length);
        expect(resolveCredit(text, evidence)).toEqual(artists);
        expect(artists.every((artist) => text.includes(artist))).toBe(true);
        expect(staysWhole(text, artists)).toBe(artists.length === 1 && artists[0] === text.trim());
      }),
    );
  });
});

describe("distinctNames and joinCreditNames", () => {
  it("keep the first spelling in order, and join the way a combined credit string does", () => {
    expect(distinctNames(["B", "a", "b", " A ", ""])).toEqual(["B", "a"]);
    expect(joinCreditNames([])).toBe("");
    expect(joinCreditNames(["A"])).toBe("A");
    expect(joinCreditNames(["A", "B"])).toBe("A & B");
    expect(joinCreditNames(["A", "B", "C"])).toBe("A, B & C");
  });
});
