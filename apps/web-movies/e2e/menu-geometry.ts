import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/** Waits for `menu`'s opening animation to finish, so its box is the one it settles at. */
export const settled = async (menu: Locator): Promise<void> => {
  await expect(menu).toBeVisible();
  await menu.evaluate(async (popup) => {
    await Promise.all(popup.getAnimations().map(async (animation) => animation.finished));
  });
};

/** `menu`, once settled, lies inside the window and above `trigger`. */
export const expectAboveTrigger = async (
  page: Page,
  menu: Locator,
  trigger: Locator,
): Promise<void> => {
  await settled(menu);

  const viewport = page.viewportSize();
  const box = await menu.boundingBox();
  const anchor = await trigger.boundingBox();

  if (viewport === null || box === null || anchor === null) throw new Error("Nothing to measure");

  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(anchor.y);
};
