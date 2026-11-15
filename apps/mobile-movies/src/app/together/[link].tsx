import { describeFailure } from "@media/mobile-core/failure";
import { usePlatform } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { Link2Off, LockKeyhole } from "lucide-react-native";
import { Predicate } from "effect";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { MOVIES, parseSessionLink } from "@/lib/together/session";

/** Why a link cannot be joined, from the core's refusal. */
interface Refusal {
  readonly title: string;
  readonly description: string;
  readonly locked: boolean;
}

const refusalOf = (cause: unknown): Refusal => {
  const message = describeFailure(cause);

  if (Predicate.isTagged(cause, "Expired")) {
    return { title: "Session Ended", description: "Ask for a new link.", locked: false };
  }

  return Predicate.isTagged(cause, "Forbidden") && /locked/iu.test(message)
    ? {
        title: "Session Locked",
        description: "The host isn’t letting anyone new in. Ask them to open it.",
        locked: true,
      }
    : { title: "Can’t Join", description: message, locked: false };
};

const NOT_A_LINK: Refusal = {
  title: "Can’t Join",
  description: "This link doesn’t open a group session.",
  locked: false,
};

/**
 * A group session's link, `movies://together/<link>`: joins the person's movies session through
 * it, then opens the session screen, which plays the session or says why it waits.
 */
export default function JoinSession() {
  const params = useLocalSearchParams<{ link?: string }>();
  const link = parseSessionLink(params.link ?? "");
  const platform = usePlatform();
  const [refused, setRefused] = useState<Refusal | null>(link === null ? NOT_A_LINK : null);

  useEffect(() => {
    if (link === null) return undefined;

    let active = true;

    platform.core.together.join({ domain: MOVIES, link }).then(
      () => {
        if (active) router.replace("/together");

        return undefined;
      },
      (cause: unknown) => {
        if (active) setRefused(refusalOf(cause));
      },
    );

    return () => {
      active = false;
    };
  }, [platform, link]);

  return (
    <Screen header={<NavHeader title="Watch Together" />}>
      {refused === null ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator accessibilityLabel="Joining the session" />
        </View>
      ) : (
        <CalmState
          icon={refused.locked ? LockKeyhole : Link2Off}
          title={refused.title}
          description={refused.description}
          actions={<Button label="Go Home" onPress={() => router.dismissTo("/")} />}
        />
      )}
    </Screen>
  );
}
