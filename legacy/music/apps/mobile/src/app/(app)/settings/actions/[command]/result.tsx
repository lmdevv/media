/** F28 · Result: what the command did, read from the route's parameters. */
import { useLocalSearchParams } from "expo-router";

import { ActionResultScreen } from "@/components/actions/action-result";
import { parseResultRoute } from "@/lib/actions";

export default function Screen() {
  const params = useLocalSearchParams<{ command: string }>();

  return <ActionResultScreen command={params.command} route={parseResultRoute(params)} />;
}

export { RouteFailure as ErrorBoundary } from "@/components/settings/route-failure";
