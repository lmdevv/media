/**
 * Keeps showing what a confirmation sheet is about once it is gone from its list. Removing a
 * person removes them from `people.list` before the sheet closes; without this the sheet would
 * flash "not found" on its way out.
 */
import { useState } from "react";

/**
 * `value`, or the last one seen once it turns null. Undefined (still loading) passes through, and
 * null stays null when nothing was ever seen.
 */
export const useLastKnown = <T>(value: T | null | undefined): T | null | undefined => {
  const [last, setLast] = useState<T | null>(null);

  if (value !== null && value !== undefined && value !== last) setLast(value);

  return value === null ? last : value;
};
