/** Paper's quiet confirmation: a label that says `Copied` or `Saved` for a moment, then reverts. */
import { useEffect, useState } from "react";

/** How long a quiet confirmation stays. */
const SHOWN_MS = 2000;

/** Whether the confirmation shows, and the function that shows it again. */
export const useFlash = (): readonly [boolean, () => void] => {
  const [shownAt, setShownAt] = useState<number | null>(null);

  useEffect(() => {
    if (shownAt === null) return undefined;

    const timer = setTimeout(() => setShownAt(null), SHOWN_MS);

    return () => clearTimeout(timer);
  }, [shownAt]);

  return [shownAt !== null, () => setShownAt(Date.now())];
};
