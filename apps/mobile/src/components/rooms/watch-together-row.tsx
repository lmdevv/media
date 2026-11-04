import type { TitleId } from "@media/contracts/ids";
import { router } from "expo-router";
import { UsersRound } from "lucide-react-native";

import { ListRow } from "@/components/ui/list-row";
import { togetherHref } from "@/lib/routes";

/** The row that starts a watch room for `titleId`. */
export function WatchTogetherRow({ titleId }: { readonly titleId: TitleId }) {
  return (
    <ListRow
      icon={UsersRound}
      title="Watch Together"
      onPress={() => router.push(togetherHref({ titleId }))}
    />
  );
}
