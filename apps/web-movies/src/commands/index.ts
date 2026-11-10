import type { CommandPage } from "@media/ui/lib/command-menu";
import { useMemo } from "react";

import { useAdminCommands } from "./admin";
import { useBrowseCommands } from "./browse";
import type { CommandContext } from "./contribution";
import { mergeContributions } from "./contribution";
import { useLibraryCommands } from "./library";
import { useMigrationCommands } from "./migration";
import { useNavigationCommands } from "./navigation";
import { usePlaybackCommands } from "./playback";
import { usePreferenceCommands } from "./preferences";

export type { CommandContext, PlayerCommands } from "./contribution";

/** Every contribution merged into the menu's root page, in menu order. */
export const useCommandRoot = (context: CommandContext): CommandPage => {
  const playback = usePlaybackCommands(context);
  const browse = useBrowseCommands(context);
  const navigation = useNavigationCommands(context);
  const preferences = usePreferenceCommands();
  const library = useLibraryCommands(context);
  const admin = useAdminCommands(context);
  const migration = useMigrationCommands(context);

  return useMemo((): CommandPage => {
    const { groups, fallback } = mergeContributions([
      playback,
      browse,
      navigation,
      library,
      admin,
      migration,
      preferences,
    ]);

    return { id: "root", placeholder: "Search or jump to…", groups, fallback: () => fallback };
  }, [playback, browse, navigation, preferences, library, admin, migration]);
};
