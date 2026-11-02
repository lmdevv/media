import { errorMessage } from "@music/sdk/errors";
import { router } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { CircleAlert } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";

/** The page in place of one whose record is gone or can't be read. */
export function RouteFailure({ error, retry }: ErrorBoundaryProps) {
  return (
    <Page title="" bottom="plain">
      <EmptyState
        icon={CircleAlert}
        title="This is no longer here."
        body={errorMessage(error)}
        primary={<Button label="Go back" onPress={() => router.back()} />}
        secondary={<Button label="Try again" variant="secondary" onPress={() => void retry()} />}
      />
    </Page>
  );
}
