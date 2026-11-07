import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { button, userId } from "./people/fixtures";
import { PersonalPickerView } from "./personal-picker";

const noop = (): void => undefined;

describe("PersonalPickerView", () => {
  it("shows each person here, a lock on one this browser lost, and Add someone", () => {
    const html = renderToStaticMarkup(
      <PersonalPickerView
        tiles={[
          { userId: userId("ada"), username: "ada", here: true },
          { userId: userId("bo"), username: "bo", here: false },
        ]}
        onPick={noop}
        onAdd={noop}
      />,
    );

    expect(html).toContain("Who&#x27;s here?");
    expect(html).toContain('aria-label="ada"');
    expect(html).toContain('aria-label="bo, sign in again"');
    expect(button(html, "Add someone").disabled).toBe(false);
  });
});
