import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Vitest hands CSS imports to tests as empty strings, even with `?raw`.
const css = readFileSync(
  new URL("../../../../packages/ui/src/styles/globals.css", import.meta.url),
  "utf8",
);

const sources = Object.entries({
  ...import.meta.glob<string>(
    ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../routeTree.gen.ts"],
    {
      query: "?raw",
      import: "default",
      eager: true,
    },
  ),
  ...import.meta.glob<string>(
    [
      "../../../../packages/ui/src/**/*.{ts,tsx}",
      "!../../../../packages/ui/src/**/*.test.{ts,tsx}",
    ],
    { query: "?raw", import: "default", eager: true },
  ),
}).map(([path, text]) => ({ path: path.replace(/^(\.\.\/)+/u, ""), text }));

const spacingSteps = new Set(
  [...css.matchAll(/--spacing-([\d_]+):/gu)].map((match) => (match[1] ?? "").replace("_", ".")),
);

const definedVariables = new Set([...css.matchAll(/(--[\w-]+):/gu)].map((match) => match[1]));

const SPACING_UTILITY =
  /(?<![\w-])-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end|translate-[xy]|scroll-[mp][xytrblse]?)-(\d+(?:\.\d+)?)(?![\w./-])/gu;

const TAILWIND_DEFAULT_SIZE =
  /(?<![\w-])(?:text-(?:xs|sm|base|lg|[2-9]?xl)|rounded(?:-[setrbl]{1,2})?-(?:xs|sm|md|lg|[2-4]?xl)|shadow-(?:2xs|xs|sm|md|lg|2?xl)|font-(?:thin|extralight|light|normal|extrabold|black)|leading-(?:none|tight|snug|normal|relaxed|loose)|tracking-(?:tighter|normal|wide|wider|widest))(?![\w-])/gu;

const ARBITRARY_VALUE = /(?<![\w-])[\w:-]*-\[([^\]\s"'`]+)\]/gu;

const findings = (pattern: RegExp, accept: (match: RegExpExecArray) => boolean) =>
  sources.flatMap(({ path, text }) =>
    [...text.matchAll(pattern)].flatMap((match) => (accept(match) ? [] : [`${path}: ${match[0]}`])),
  );

describe("design tokens", () => {
  it("reads the web app, the UI kit, and the theme", () => {
    expect(sources.some(({ path }) => path.startsWith("packages/ui/src/components/"))).toBe(true);
    expect(sources.some(({ path }) => path.startsWith("components/"))).toBe(true);
    expect(spacingSteps.has("4")).toBe(true);
    expect(spacingSteps.has("1.5")).toBe(true);
  });

  it("takes every padding, margin, gap, and offset from the spacing scale", () => {
    expect(
      findings(SPACING_UTILITY, (match) => match[1] === "0" || spacingSteps.has(match[1] ?? "")),
    ).toEqual([]);
  });

  it("uses Paper sizes instead of Tailwind's", () => {
    expect(findings(TAILWIND_DEFAULT_SIZE, () => false)).toEqual([]);
  });

  it("keeps raw lengths out of arbitrary values", () => {
    expect(
      findings(ARBITRARY_VALUE, (match) => !/\d(?:px|r?em)\b|--spacing\(/u.test(match[1] ?? "")),
    ).toEqual([]);
  });

  it("only reads spacing variables the theme defines", () => {
    expect(
      findings(/var\((--spacing-[\w-]+)\)/gu, (match) => definedVariables.has(match[1])),
    ).toEqual([]);
  });
});
