import type { Page } from "@playwright/test";

declare global {
  interface Window {
    musicTestMedia?: Set<HTMLMediaElement>;
    /** When a media element the page played last paused, in milliseconds since the epoch. */
    musicTestPausedAt?: number;
  }
}

/** How far the page's playing audio has got, in seconds; 0 while nothing plays. */
export const audioSeconds = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Math.max(
      0,
      ...[...(window.musicTestMedia ?? [])].map((media) => (media.paused ? 0 : media.currentTime)),
    ),
  );

/** When the page's audio last paused, in milliseconds since the epoch; 0 before it did. */
export const pausedAt = (page: Page): Promise<number> =>
  page.evaluate(() => window.musicTestPausedAt ?? 0);

/** Collects every media element the page plays, and when one pauses, for the readers above. */
export const watchMedia = async (page: Page): Promise<void> => {
  await page.addInitScript({
    content: `
      window.musicTestMedia = new Set();
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!window.musicTestMedia.has(this)) {
          this.addEventListener("pause", () => {
            window.musicTestPausedAt = Date.now();
          });
        }
        window.musicTestMedia.add(this);
        return play.call(this);
      };
    `,
  });
};
