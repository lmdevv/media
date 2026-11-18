import { parseInviteLink } from "@/lib/invite-link";

export const redirectSystemPath = ({
  path,
  initial,
}: {
  readonly path: string;
  readonly initial: boolean;
}): string | null => {
  if (parseInviteLink(path) === null) return path;

  return initial ? "/" : null;
};
