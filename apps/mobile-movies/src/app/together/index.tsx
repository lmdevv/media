import { describeFailure } from "@media/mobile-core/failure";
import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";
import { EyeOff, Hourglass, Link2Off } from "lucide-react-native";
import { useEffect } from "react";
import { ActivityIndicator, Alert, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { watchHref } from "@/lib/routes";
import { MOVIES, moviesItem } from "@/lib/together/session";
import { useSessionTarget } from "@/lib/together/use-session-target";
import { useCurrentSession } from "@/session/together";

const goHome = (): void => {
  router.dismissTo("/");
};

/**
 * The person's movies session: opens the player on what it plays, or says why it cannot yet:
 * waiting for the host, a session playing something they may not watch, or one that ended.
 */
export default function CurrentSession() {
  const platform = usePlatform();
  const view = useCurrentSession();
  const joined = view?.state === "joined" ? view : null;
  const target = useSessionTarget(moviesItem(joined?.item ?? null));
  const ready = joined !== null && target.status === "ready" ? target.target : null;

  useEffect(() => {
    if (ready === null) return;

    router.replace(watchHref({ titleId: ready.titleId, episodeId: ready.episodeId ?? undefined }));
  }, [ready]);

  const leave = (): void => {
    void platform.core.together
      .leave({ domain: MOVIES })
      .then(goHome)
      .catch((cause: unknown) => Alert.alert("Couldn’t Leave", describeFailure(cause)));
  };

  const home = <Button label="Go Home" variant="secondary" onPress={goHome} />;

  const content = (() => {
    if (view === null) {
      return <CalmState icon={Link2Off} title="Not in a Session" actions={home} />;
    }

    if (view?.state === "pending") {
      return (
        <CalmState
          icon={Hourglass}
          title={`Waiting for ${view.host}`}
          description={`You join as soon as ${view.host} lets you in.`}
          actions={<Button label="Leave Session" variant="secondary" onPress={leave} />}
        />
      );
    }

    if (view?.state === "ended") {
      return <CalmState icon={Link2Off} title="Session Ended" actions={home} />;
    }

    if (joined !== null && target.status === "unavailable") {
      return (
        <CalmState
          icon={EyeOff}
          title="Not Available"
          description="The session plays something you can’t watch. You keep your place, and the player comes back when it plays something you can."
          actions={<Button label="Leave Session" variant="secondary" onPress={leave} />}
        />
      );
    }

    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator accessibilityLabel="Opening the session" />
      </View>
    );
  })();

  return <Screen header={<NavHeader title="Watch Together" />}>{content}</Screen>;
}
