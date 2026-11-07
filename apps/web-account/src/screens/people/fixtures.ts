import { Brand } from "effect";

import type { Approval, SharedPicker, SharedTile, UserId } from "@/session/platform-types";

export const userId: (raw: string) => UserId = Brand.nominal<UserId>();

const approvalId: (raw: string) => Approval["approvalId"] = Brand.nominal<Approval["approvalId"]>();

const deviceId: (raw: string) => SharedPicker["deviceId"] =
  Brand.nominal<SharedPicker["deviceId"]>();

/** An open adult tile with no unlock code; override what a test is about. */
export const tile = (
  username: string,
  fields: Partial<Omit<SharedTile, "username">> = {},
): SharedTile => ({
  userId: userId(username),
  username,
  kid: false,
  code: "none",
  lock: { state: "open" },
  ...fields,
});

/** A shared device's picker listing `tiles`. */
export const sharedPicker = (
  tiles: ReadonlyArray<SharedTile>,
  fields: Partial<Pick<SharedPicker, "holder" | "approval">> = {},
): SharedPicker => ({
  deviceId: deviceId("d1"),
  name: "Living room TV",
  mode: "shared",
  holder: null,
  approval: null,
  tiles,
  ...fields,
});

/** An approval for `intent` on `who`'s tile, two minutes from `now`. */
export const approval = (
  who: UserId,
  state: Approval["state"],
  fields: Partial<Pick<Approval, "intent" | "expiresAt" | "approvalId">> = {},
): Approval => ({
  approvalId: approvalId("a1"),
  intent: "open",
  userId: who,
  state,
  expiresAt: Date.now() + 120_000,
  ...fields,
});

export const anApprovalId = approvalId;

/** The text of each button in `html`, and whether it is disabled. */
const buttons = (
  html: string,
): ReadonlyArray<{ readonly text: string; readonly disabled: boolean }> =>
  [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gsu)].map((match) => ({
    text: (match[2] ?? "").replaceAll(/<[^>]*>/gu, "").trim(),
    disabled: /\sdisabled=""/u.test(match[1] ?? ""),
  }));

/** The button labelled `text` in `html`; fails the test when there is none. */
export const button = (
  html: string,
  text: string,
): { readonly text: string; readonly disabled: boolean } => {
  const found = buttons(html).find((each) => each.text === text);

  if (found === undefined) throw new Error(`No button "${text}" in ${html}`);

  return found;
};
