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
