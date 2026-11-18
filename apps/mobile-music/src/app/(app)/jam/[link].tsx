import { describeFailure } from "@media/mobile-core/failure";
import { MUSIC } from "@media/player/session-react";
import { usePlatform } from "@media/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { Link2Off } from "lucide-react-native";
import { useEffect, useState } from "react";

import { jamNavGlyph } from "@/components/jams/jam-home";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";
import { parseJamLink } from "@/lib/jam";

/**
 * A Jam's link opened in the app, `music://jam/<link>`: joins through it, then shows the Jam, or
 * why it cannot be joined.
 */
export default function JoinByLink() {
  const platform = usePlatform();
  const params = useLocalSearchParams<{ link?: string }>();
  const link = parseJamLink(params.link ?? "");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (link === null) return undefined;

    let active = true;

    platform.core.together.join({ domain: MUSIC, link }).then(
      () => {
        if (active) router.replace("/jam");

        return undefined;
      },
      (cause: unknown) => {
        if (active) setFailure(describeFailure(cause));
      },
    );

    return () => {
      active = false;
    };
  }, [platform, link]);

  if (link !== null && failure === null) {
    return (
      <Page title="Join a Jam" bottom="plain" trailing={jamNavGlyph}>
        {null}
      </Page>
    );
  }

  return (
    <Page title="Join a Jam" bottom="plain" trailing={jamNavGlyph}>
      <EmptyState
        icon={Link2Off}
        title="This Jam link doesn’t work."
        body={failure ?? "Ask the host for the current one."}
        spacing="hero"
        primary={
          <Button
            label="Back to my music"
            onPress={() => {
              router.dismissAll();
            }}
          />
        }
      />
    </Page>
  );
}
