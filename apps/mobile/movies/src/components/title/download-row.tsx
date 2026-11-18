import { useDownloadAction } from "@/components/downloads/use-download-action";
import type { DownloadTarget } from "@/components/downloads/use-download-action";
import { ListRow } from "@/components/ui/list-row";

import type { SheetExit } from "./sheet";

/**
 * The Download row of a title's or an episode's actions, for the version file `target` names;
 * nothing while no one is signed in here. A queued download closes the sheet; one already queued
 * or kept opens its page.
 */
export function DownloadRow({
  target,
  exit,
}: {
  readonly target: DownloadTarget;
  readonly exit: SheetExit;
}) {
  const download = useDownloadAction(target);

  if (download === null) return null;

  return (
    <ListRow
      icon={download.icon}
      title={download.title}
      detail={download.detail}
      onPress={() => {
        const page = download.press();

        if (page === null) exit.close();
        else exit.leaveFor(page);
      }}
    />
  );
}
