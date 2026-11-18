import { describe, expect, it } from "vitest";

import * as fc from "fast-check";

import {
  USER_CODE_LENGTH,
  approvalAddress,
  codeGroups,
  codeLetters,
  expiresInLine,
  formatUserCode,
  scannedUserCode,
  spokenCode,
} from "./device-code";

describe("device code", () => {
  it("splits the code into its groups of boxes", () => {
    expect(codeGroups("bcdf-ghjk")).toEqual([
      ["B", "C", "D", "F"],
      ["G", "H", "J", "K"],
    ]);
    expect(codeGroups("J7K4P2")).toEqual([["J", "7", "K", "4", "P", "2"]]);
    expect(spokenCode("BCDF-GHJK")).toBe("B C D F, G H J K");
  });

  it("counts down to expiry", () => {
    expect(expiresInLine(292_000, 0)).toBe("Expires in 4:52");
    expect(expiresInLine(500, 0)).toBe("Expires in 0:01");
    expect(expiresInLine(0, 10_000)).toBe("Expires in 0:00");
  });

  it("shows the approval page without scheme or code", () => {
    expect(approvalAddress("https://cinema.home/device?code=BCDF-GHJK")).toBe("cinema.home/device");
  });

  it("keeps up to eight code characters as typed", () => {
    expect(codeLetters(" hd5r-5gtl ")).toBe("HD5R5GTL");
    expect(codeLetters("hd5r 5gtl xyz")).toBe("HD5R5GTL");
    expect(formatUserCode("hd5r5gt")).toBeNull();
    expect(formatUserCode("hd5r5gtl")).toBe("HD5R-5GTL");
    expect(formatUserCode("HD5R-5GTL-ZZ")).toBeNull();
    fc.assert(
      fc.property(fc.string(), (typed) => {
        const letters = codeLetters(typed);

        expect(letters.length).toBeLessThanOrEqual(USER_CODE_LENGTH);
        expect(letters).toMatch(/^[A-Z0-9]*$/u);
        expect(codeLetters(letters)).toBe(letters);
      }),
    );
  });

  it("reads the code from a scanned approval link or a bare code", () => {
    expect(scannedUserCode("https://cinema.home/device?code=HD5R-5GTL")).toBe("HD5R-5GTL");
    expect(scannedUserCode("http://192.168.1.20:8080/device/?code=hd5r5gtl")).toBe("HD5R-5GTL");
    expect(scannedUserCode("https://cinema.home/device?x=1&code=HD5R%2D5GTL#top")).toBe(
      "HD5R-5GTL",
    );
    expect(scannedUserCode("  HD5R-5GTL\n")).toBe("HD5R-5GTL");
    expect(scannedUserCode("https://cinema.home/device?code=SHORT")).toBeNull();
    expect(scannedUserCode("https://cinema.home/device?code=HD5R-5GTL-ZZ")).toBeNull();
    expect(scannedUserCode("HD5R-5GTL-ZZ")).toBeNull();
    expect(scannedUserCode("https://cinema.home/device?code=%E0")).toBeNull();
    expect(scannedUserCode("https://cinema.home/invite/ABCD-EFGH")).toBeNull();
    expect(scannedUserCode("WIFI:S:home;T:WPA;P:secret;;")).toBeNull();
  });
});
