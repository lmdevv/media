/**
 * Incoming links. Invite and reset links are not routed directly: their server may need
 * connecting first, which `EntryLinksProvider` does before it opens the screen. Routing keeps the
 * current screen meanwhile, or the first one at launch.
 */
import { parseEntryLink } from "@/lib/entry-link";

export const redirectSystemPath = ({
  path,
  initial,
}: {
  readonly path: string;
  readonly initial: boolean;
}): string | null => {
  if (parseEntryLink(path) === null) return path;

  return initial ? "/" : null;
};
