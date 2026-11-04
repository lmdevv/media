import { Match } from "effect";

import { plural } from "../../lib/format";

/** What a new playlist starts with. */
export type StartWith = "nothing" | "selection" | "queue" | "liked";

/**
 * What the new playlist will start with, for the New playlist dialog's live region: it changes as
 * a "Start with" option is picked, so screen readers hear the choice (ADS-108).
 */
export const startsWith = (startWith: StartWith, selected: number, queued: number): string =>
  Match.value(startWith).pipe(
    Match.when("selection", () => `Starts with ${plural(selected, "selected song")}`),
    Match.when("nothing", () => "Starts empty"),
    Match.when("queue", () => `Starts with the current queue, ${plural(queued, "song")}`),
    Match.when("liked", () => "Starts with your liked songs"),
    Match.exhaustive,
  );
