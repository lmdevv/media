/**
 * D05 · a Jam invite, signed in: whose Jam it is and Ask to join (or Join, when the host lets
 * anyone in). Joining listens along on this iPhone when the host allows it, then opens the Jam:
 * waiting (D06) or in it (D08). A link that can't be joined says why (G11, G12). Opened with
 * `?join=1` after a guest sign-up, which already put the guest in the Jam, it joins on this
 * iPhone straight away.
 *
 * The server's preview names the host and nothing of what plays or who listens, so the hero shows
 * the Jam glyph where Paper draws the album.
 */
import { jamPreview } from "@music/sdk/functions";
import { errorMessage } from "@music/sdk/errors";
import { useRead, useRun } from "@music/sdk/react";
import { useQuery } from "convex/react";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { ListOrdered, Users } from "lucide-react-native";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";

import { jamNavGlyph } from "@/components/jams/jam-home";
import { JamUnavailable, unavailableOf } from "@/components/jams/jam-unavailable";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Text } from "@/components/ui/text";
import { useDevices } from "@/player";

const blank = (
  <Page title="Join a Jam" bottom="plain" trailing={jamNavGlyph}>
    {null}
  </Page>
);

/** Joins the Jam `code` on this iPhone; resolves once the Jam screen has taken over. */
const useJoin = (code: string) => {
  const join = useRun("jam.join");
  const { thisDevice } = useDevices();

  return async () => {
    await join({ code, deviceId: thisDevice.id });
    router.replace("/jam");
  };
};

/** The join button, with its pending label and the server's refusal under it. */
function JoinButton({ code, label }: { readonly code: string; readonly label: string }) {
  const join = useJoin(code);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async () => {
    setPending(true);
    setFailure(null);

    try {
      await join();
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t join. Try again.");
      setPending(false);
    }
  };

  return (
    <View className="gap-2">
      <Button label={label} pendingLabel="Joining…" pending={pending} onPress={() => void run()} />
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" accessibilityLiveRegion="polite">
          {failure}
        </Text>
      )}
    </View>
  );
}

/** After a guest sign-up: joins on this iPhone at once. */
function JoinOnArrival({ code }: { readonly code: string }) {
  const join = useJoin(code);
  const [failure, setFailure] = useState<string | null>(null);

  const arrive = useEffectEvent(() => {
    join().catch((cause: unknown) => {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t join. Try again.");
    });
  });

  useEffect(() => {
    arrive();
  }, []);

  if (failure === null) return blank;

  return (
    <Page title="Join a Jam" bottom="plain" trailing={jamNavGlyph}>
      <Text variant="calloutMedium" tone="danger" className="pt-6">
        {failure}
      </Text>
    </Page>
  );
}

export default function JamInvite() {
  const { code, join } = useLocalSearchParams<{ code: string; join?: string }>();
  const preview = useQuery(jamPreview, { code });
  const current = useRead("jam.get", {});

  if (join === "1") return <JoinOnArrival code={code} />;

  if (preview === undefined || current === undefined) return blank;

  // Already in this Jam, as its host or a member: the Jam itself.
  if (current !== null && current.status === "active" && current.code === code) {
    return <Redirect href="/jam" />;
  }

  if (preview.state === "invalid" || preview.state === "ended") {
    return <JamUnavailable state={preview.state} hostName="" signedIn />;
  }

  const unavailable = unavailableOf(preview);

  if (unavailable !== null) {
    return (
      <JamUnavailable
        state={unavailable}
        hostName={preview.hostName}
        signedIn
        retry={<JoinButton code={code} label="Try again" />}
      />
    );
  }

  const host = preview.hostName;

  return (
    <Page title="Join a Jam" bottom="plain" trailing={jamNavGlyph}>
      <View className="gap-6">
        <View className="items-center gap-3 pt-6 pb-2">
          <View className="size-ios-224 items-center justify-center rounded-mobile-card bg-surface">
            <Icon icon={Users} size="state" tone="muted" />
          </View>
          <Text variant="title" className="mt-2 text-center" accessibilityRole="header">
            {`Join ${host}’s Jam`}
          </Text>
          <Text variant="callout" tone="muted" className="text-center">
            {preview.state === "approval"
              ? `Hosted by ${host} · Needs ${host}’s OK`
              : `Hosted by ${host}`}
          </Text>
        </View>
        <Notice
          icon={ListOrdered}
          title="Your music will wait"
          body="Your own queue comes back when you leave the Jam."
        />
        <JoinButton code={code} label={preview.state === "approval" ? "Ask to join" : "Join"} />
      </View>
    </Page>
  );
}
