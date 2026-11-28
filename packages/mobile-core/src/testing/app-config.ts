import { readFileSync } from "node:fs";

/** The text of an iOS app's `app.json`, such as `movies`'s. */
export const appConfigText = (app: string): string =>
  readFileSync(new URL(`../../../../apps/mobile/${app}/app.json`, import.meta.url), "utf8");
