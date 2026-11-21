import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Segmented } from "./segmented";

const QUALITIES = [
  { value: "saver", label: "Data saver" },
  { value: "high", label: "High" },
  { value: "lossless", label: "Lossless" },
] as const;

/** Each option as the browser sees it: a native radio button inside the label that names it. */
const radiosIn = (html: string) =>
  [...html.matchAll(/<label[^>]*><input([^>]*)>([^<]*)<\/label>/gu)].map(
    ([, attributes = "", label]) => ({
      label,
      radio: attributes.includes('type="radio"'),
      group: /name="([^"]+)"/u.exec(attributes)?.[1],
      checked: attributes.includes('checked=""'),
    }),
  );

describe("Segmented", () => {
  it("offers each option as a radio button named by its label, with the chosen one checked", () => {
    const html = renderToStaticMarkup(
      <Segmented
        label="Streaming quality"
        value="high"
        options={QUALITIES}
        onChange={() => undefined}
      />,
    );

    const radios = radiosIn(html);

    expect(html).toContain('role="radiogroup" aria-label="Streaming quality"');
    expect(radios.map(({ label, radio, checked }) => ({ label, radio, checked }))).toEqual([
      { label: "Data saver", radio: true, checked: false },
      { label: "High", radio: true, checked: true },
      { label: "Lossless", radio: true, checked: false },
    ]);
    expect(new Set(radios.map(({ group }) => group)).size).toBe(1);
    expect(radios[0]?.group).toBeDefined();
  });
});
