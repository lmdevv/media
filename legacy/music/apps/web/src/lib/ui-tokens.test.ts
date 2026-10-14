import { readFileSync } from "node:fs";

import { cn } from "@music/ui/lib/utils";
import { describe, expect, it } from "vitest";

// The tokens and `cn` live in @music/ui; this test sits here because the web app's test setup
// can read files, and the web app is where a misclassified token breaks a screen.
const css = readFileSync(
  new URL("../../../../packages/ui/src/styles/globals.css", import.meta.url),
  "utf8",
);

/** Every `--name: value` declared in the `@theme { … }` blocks (not `@theme inline`). */
const themeNames: ReadonlyArray<string> = [...css.matchAll(/@theme \{([\s\S]*?)\n\}/g)].flatMap(
  (block) => [...(block[1] ?? "").matchAll(/^\s*--([a-z0-9-]+):/gm)].map((match) => match[1] ?? ""),
);

/** The token names in one namespace, such as `shadow` for `--shadow-dialog`. */
const tokens = (namespace: string): ReadonlyArray<string> =>
  themeNames.flatMap((name) => {
    const token = name.slice(namespace.length + 1);

    return name.startsWith(`${namespace}-`) && !name.includes("--") && !/^\d+$/.test(token)
      ? [token]
      : [];
  });

/**
 * `cn` merges classes it can classify. A token missing from its lists in `utils.ts` merges as the
 * wrong group, so these fail when `globals.css` gains a token `cn` doesn't know.
 */
describe("cn knows every token in globals.css", () => {
  it("reads the theme", () => {
    expect(tokens("shadow").length).toBeGreaterThan(0);
  });

  it.each(tokens("text"))("text-%s is a font size", (name) => {
    expect(cn("text-text", `text-${name}`)).toBe(`text-text text-${name}`);
    expect(cn("text-sm", `text-${name}`)).toBe(`text-${name}`);
  });

  it.each(tokens("leading"))("leading-%s is a line height", (name) => {
    expect(cn("leading-4", `leading-${name}`)).toBe(`leading-${name}`);
  });

  it.each(tokens("tracking"))("tracking-%s is a letter spacing", (name) => {
    expect(cn("tracking-wide", `tracking-${name}`)).toBe(`tracking-${name}`);
  });

  it.each(tokens("font-weight"))("font-%s is a font weight", (name) => {
    expect(cn("font-bold", `font-${name}`)).toBe(`font-${name}`);
  });

  it.each(tokens("radius"))("rounded-%s is a radius", (name) => {
    expect(cn("rounded-sm", `rounded-${name}`)).toBe(`rounded-${name}`);
  });

  it.each(tokens("shadow"))("shadow-%s is a shadow", (name) => {
    expect(cn("shadow-sm", `shadow-${name}`)).toBe(`shadow-${name}`);
  });

  it.each(tokens("spacing"))("p-%s is a spacing", (name) => {
    expect(cn("p-4", `p-${name}`)).toBe(`p-${name}`);
  });

  it.each(tokens("container"))("max-w-%s is a width", (name) => {
    expect(cn("max-w-sm", `max-w-${name}`)).toBe(`max-w-${name}`);
  });

  it.each(tokens("blur"))("backdrop-blur-%s is a blur", (name) => {
    expect(cn("backdrop-blur-sm", `backdrop-blur-${name}`)).toBe(`backdrop-blur-${name}`);
  });

  it.each(tokens("border-width"))("border-%s is a border width", (name) => {
    expect(cn("border-2", `border-${name}`)).toBe(`border-${name}`);
    expect(cn("border-border", `border-${name}`)).toBe(`border-border border-${name}`);
  });
});
