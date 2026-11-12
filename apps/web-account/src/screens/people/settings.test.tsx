import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ActionStatus } from "./action";
import { button } from "./fixtures";
import {
  DisplayNameSection,
  NameSection,
  PasswordSection,
  PlaybackSection,
  SharedDevicesSection,
  UnlockCodeSection,
} from "./settings";
import type { Settings } from "./settings";

const noop = (): void => undefined;

const IDLE: ActionStatus = { kind: "idle" };

const PENDING: ActionStatus = { kind: "pending" };

const DONE: ActionStatus = { kind: "done" };

const FAILED: ActionStatus = { kind: "failed", message: "That username is taken." };

const SETTINGS: Settings = {
  user: {
    subtitleLanguage: "fr",
    audioLanguage: null,
    subtitleStyle: { size: "large", color: "yellow", backdrop: "box" },
    autoplay: true,
    explicitFilter: false,
    crossfade: 4,
    gapless: true,
  },
  device: { streamQuality: "high", downloadQuality: "standard", volume: 0.37 },
};

const selected = (html: string): ReadonlyArray<string> =>
  [...html.matchAll(/<option[^>]*selected=""[^>]*>([^<]*)<\/option>/gu)].map(
    (match) => match[1] ?? "",
  );

const renderName = (status: ActionStatus): string =>
  renderToStaticMarkup(<NameSection username="ada" status={status} onRename={noop} />);

describe("NameSection", () => {
  it("shows the username, with Save off until it changes", () => {
    const html = renderName(IDLE);

    expect(html).toContain('value="ada"');
    expect(button(html, "Save").disabled).toBe(true);
  });

  it("says when it saved and why it failed", () => {
    expect(renderName(DONE)).toContain("Username saved.");
    expect(renderName(FAILED)).toContain("That username is taken.");
  });
});

const renderDisplayName = (displayName: string | null, status: ActionStatus): string =>
  renderToStaticMarkup(
    <DisplayNameSection displayName={displayName} username="ada" status={status} onSave={noop} />,
  );

describe("DisplayNameSection", () => {
  it("shows the name the person goes by, with the username as its placeholder", () => {
    const html = renderDisplayName("Ada Lovelace", IDLE);

    expect(html).toContain('value="Ada Lovelace"');
    expect(html).toContain('placeholder="ada"');
    expect(button(html, "Save").disabled).toBe(true);
  });

  it("starts empty without a name, holds Save while saving, and says when it saved", () => {
    expect(renderDisplayName(null, IDLE)).toContain('value=""');
    expect(button(renderDisplayName(null, PENDING), "Save").disabled).toBe(true);
    expect(renderDisplayName("Ada", DONE)).toContain("Name saved.");
    expect(renderDisplayName("Ada", FAILED)).toContain("That username is taken.");
  });
});

const renderPassword = (status: ActionStatus): string =>
  renderToStaticMarkup(<PasswordSection status={status} onChange={noop} />);

describe("PasswordSection", () => {
  it("asks for both passwords and says what changing it does", () => {
    const html = renderPassword(IDLE);

    expect(html).toContain("Current password");
    expect(html).toContain("New password, 8 to 256 characters");
    expect(html).toContain("Changing it signs you out everywhere else.");
    expect(button(html, "Change password").disabled).toBe(true);
  });

  it("says when it changed and why it failed", () => {
    expect(renderPassword(DONE)).toContain("Password changed.");
    expect(renderPassword({ kind: "failed", message: "Wrong password." })).toContain(
      "Wrong password.",
    );
  });
});

const renderCode = (status: ActionStatus): string =>
  renderToStaticMarkup(<UnlockCodeSection status={status} onSet={noop} />);

describe("UnlockCodeSection", () => {
  it("explains the code opens a tile on shared devices only, and offers set and off", () => {
    const html = renderCode(IDLE);

    expect(html).toContain(
      "4 to 7 digits that open your tile on a shared device&#x27;s lock screen. It never signs you in.",
    );
    expect(button(html, "Set code").disabled).toBe(true);
    expect(button(html, "Turn off").disabled).toBe(false);
  });

  it("holds both actions while one runs, and reports the outcome", () => {
    expect(button(renderCode(PENDING), "Turn off").disabled).toBe(true);
    expect(renderCode(DONE)).toContain("Unlock code saved.");
    expect(renderCode({ kind: "failed", message: "Use 4 to 7 digits." })).toContain(
      "Use 4 to 7 digits.",
    );
  });
});

const renderListing = (kid: boolean, status: ActionStatus): string =>
  renderToStaticMarkup(<SharedDevicesSection kid={kid} status={status} onList={noop} />);

describe("SharedDevicesSection", () => {
  it("offers an adult both putting themselves on and taking themselves off", () => {
    const html = renderListing(false, IDLE);

    expect(button(html, "Show me").disabled).toBe(false);
    expect(button(html, "Take me off").disabled).toBe(false);
    expect(renderListing(false, DONE)).toContain("You&#x27;re on shared devices.");
  });

  it("tells a kid an admin decides, with nothing to press", () => {
    const html = renderListing(true, IDLE);

    expect(html).toContain("An admin decides whether you show on shared devices.");
    expect(html).not.toContain("<button");
  });
});

const renderPlayback = (settings: Settings, status: ActionStatus): string =>
  renderToStaticMarkup(<PlaybackSection settings={settings} status={status} onChange={noop} />);

describe("PlaybackSection", () => {
  it("shows each setting's value, grouped by whether it follows the person", () => {
    const html = renderPlayback(SETTINGS, IDLE);

    expect(html).toContain("These follow you to every device.");
    expect(html).toContain("These stay on this browser.");
    expect(selected(html)).toEqual([
      "French",
      "The file&#x27;s own",
      "Large",
      "Yellow",
      "Box",
      "4 s",
      "High, 1080p",
      "Standard",
      "37%",
    ]);
    expect(html.match(/role="switch"[^>]*aria-checked="true"/gu)?.length).toBe(2);
  });

  it("leaves out device settings for a session on no device", () => {
    expect(renderPlayback({ ...SETTINGS, device: null }, IDLE)).not.toContain("On this device");
  });

  it("holds the controls while a change saves, and shows why one failed", () => {
    expect(renderPlayback(SETTINGS, PENDING)).toMatch(/<select[^>]*disabled=""/u);
    expect(
      renderPlayback(SETTINGS, { kind: "failed", message: "Choose a language code." }),
    ).toContain("Choose a language code.");
  });
});
