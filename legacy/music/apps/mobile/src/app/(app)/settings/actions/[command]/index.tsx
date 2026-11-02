import { useLocalSearchParams } from "expo-router";

import { ActionFormScreen } from "@/components/actions/action-form";

export default function Screen() {
  const { command } = useLocalSearchParams<{ command: string }>();

  return <ActionFormScreen command={command} />;
}

export { RouteFailure as ErrorBoundary } from "@/components/settings/route-failure";
