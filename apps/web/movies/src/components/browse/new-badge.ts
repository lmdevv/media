import type { TitleCard } from "@/lib/catalog";

const NEW_FOR_MS = 7 * 86_400_000;

/** `New` for titles added in the last week, at `now`. */
export const newBadge = (title: TitleCard, now: number): string | undefined =>
  now - title.addedAt < NEW_FOR_MS ? "New" : undefined;
