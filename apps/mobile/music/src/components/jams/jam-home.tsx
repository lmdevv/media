import { describeFailure } from "@media/mobile-core/failure";
import { MUSIC, hostName, shownName, useMusicSession } from "@media/player/session-react";
import type { JoinedSession } from "@media/player/session-react";
import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";
import { Clock, Music, Settings, Share as ShareIcon, Users } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { copyText, shareLink } from "@/components/settings/clipboard";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Page } from "@/components/ui/page";
import { Row, RowCheck, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { endedLine, jamWebUrl, nameList } from "@/lib/jam";
import { useNowPlaying } from "@/player";
import { useServer } from "@/session/connection";

import { QrCode } from "./qr-code";

/** Paper's decorative users glyph in the nav bar of the Jam screens. */
export const jamNavGlyph = (
  <View className="size-hit-target items-center justify-center">
    <Icon icon={Users} />
  </View>
);

const backToMyMusic = (): void => {
  router.dismissAll();
};

interface Running {
  readonly pending: boolean;
  readonly failure: string | null;
  readonly run: (action: () => Promise<void>) => Promise<void>;
}

const useRunning = (): Running => {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setPending(true);
    setFailure(null);

    try {
      await action();
    } catch (cause) {
      setFailure(describeFailure(cause));
    } finally {
      setPending(false);
    }
  };

  return { pending, failure, run };
};

function Failure({ failure }: { readonly failure: string | null }) {
  return failure === null ? null : (
    <Text variant="calloutMedium" tone="danger" className="pt-2 text-center">
      {failure}
    </Text>
  );
}

function JamState({
  title,
  icon,
  heading,
  body,
  actionLabel,
  pendingLabel,
  variant = "primary",
  action,
  secondary,
}: {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly heading: string;
  readonly body: string;
  readonly actionLabel: string;
  readonly pendingLabel?: string;
  readonly variant?: "primary" | "secondary";
  readonly action: () => Promise<void>;
  readonly secondary?: { readonly label: string; readonly onPress: () => void };
}) {
  const { pending, failure, run } = useRunning();

  return (
    <Page title={title} bottom="plain" trailing={jamNavGlyph}>
      <EmptyState
        icon={icon}
        title={heading}
        body={body}
        spacing="hero"
        primary={
          <Button
            label={actionLabel}
            variant={variant}
            pending={pending}
            {...(pendingLabel === undefined ? {} : { pendingLabel })}
            onPress={() => void run(action)}
          />
        }
        secondary={
          secondary === undefined ? undefined : (
            <Button label={secondary.label} variant="secondary" onPress={secondary.onPress} />
          )
        }
      />
      <Failure failure={failure} />
    </Page>
  );
}

const useLeave = (): (() => Promise<void>) => {
  const platform = usePlatform();

  return async () => {
    await platform.core.together.leave({ domain: MUSIC });
    backToMyMusic();
  };
};

function HostJam({ jam }: { readonly jam: JoinedSession }) {
  const { mediaUrl } = useServer();
  const leave = useLeave();
  const { pending, failure, run } = useRunning();
  const [copied, setCopied] = useState(false);
  const link = jamWebUrl(mediaUrl, jam.link);
  const guests = jam.members.filter((member) => member.role === "guest");
  const waiting = jam.pending ?? [];

  return (
    <Page
      title="Your Jam"
      bottom="plain"
      trailing={
        <IconButton
          icon={Settings}
          label="Jam settings"
          onPress={() => {
            router.push("/jam/settings");
          }}
        />
      }
    >
      <View className="items-center py-6">
        <QrCode value={link} label="QR code for the Jam link" />
      </View>
      <View className="flex-row gap-3">
        <Button
          label="Share link"
          icon={ShareIcon}
          className="flex-1"
          onPress={() => void shareLink(link).catch(() => undefined)}
        />
        <Button
          label={copied ? "Copied" : "Copy link"}
          variant="secondary"
          className="flex-1"
          onPress={() => {
            void copyText(link).then(() => {
              setCopied(true);

              return undefined;
            });
          }}
        />
      </View>
      <SectionHeader title="In this Jam" />
      <Row
        title="You"
        subtitle="Host"
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        trailing={<RowCheck />}
      />
      <Row
        title={guests.length === 0 ? "Nobody else yet" : nameList(guests.map(shownName))}
        subtitle={`${String(jam.members.length)} ${jam.members.length === 1 ? "person" : "people"}`}
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        trailing={<RowChevron />}
        onPress={() => {
          router.push("/jam/people");
        }}
      />
      {waiting.length === 0 ? null : (
        <Row
          title={`${nameList(waiting.map(shownName))} ${waiting.length === 1 ? "wants" : "want"} to join`}
          subtitle="Let them in or turn them away"
          active
          leading={{ kind: "icon", icon: Users, tone: "accent" }}
          trailing={<RowChevron />}
          onPress={() => {
            router.push("/jam/people");
          }}
        />
      )}
      <View className="pt-8">
        <Button
          label="End Jam"
          variant="destructive"
          pending={pending}
          pendingLabel="Ending…"
          onPress={() => void run(leave)}
        />
      </View>
      <Failure failure={failure} />
    </Page>
  );
}

function MemberJam({ jam }: { readonly jam: JoinedSession }) {
  const leave = useLeave();
  const { pending, failure, run } = useRunning();
  const others = jam.members.filter((member) => member.role === "guest");

  const can = [
    jam.may.add ? "You can add songs to the queue." : "The host isn't taking songs right now.",
    jam.may.control ? "You can also play, pause, and skip." : null,
  ]
    .filter((line) => line !== null)
    .join(" ");

  return (
    <Page title={`${hostName(jam)}'s Jam`} bottom="plain" trailing={jamNavGlyph}>
      <SectionHeader title="In this Jam" first />
      <Row
        title={hostName(jam)}
        subtitle="Host"
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
      />
      <Row
        title={nameList(others.map(shownName))}
        subtitle={`${String(jam.members.length)} ${jam.members.length === 1 ? "person" : "people"}`}
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        trailing={<RowChevron />}
        onPress={() => {
          router.push("/jam/people");
        }}
      />
      <Text tone="muted" className="pt-4">
        {can}
      </Text>
      <View className="pt-8">
        <Button
          label="Leave Jam"
          variant="destructive"
          pending={pending}
          pendingLabel="Leaving…"
          onPress={() => void run(leave)}
        />
      </View>
      <Failure failure={failure} />
    </Page>
  );
}

/** The Jam screen, by where the person stands in their Jam. */
export function JamHome() {
  const { view, start } = useMusicSession();
  const { nowPlaying } = useNowPlaying();
  const leave = useLeave();

  if (view === undefined) {
    return (
      <Page title="" bottom="plain">
        {null}
      </Page>
    );
  }

  if (view?.state === "joined") {
    return view.role === "host" ? <HostJam jam={view} /> : <MemberJam jam={view} />;
  }

  if (view?.state === "pending") {
    return (
      <JamState
        title="Join a Jam"
        icon={Clock}
        heading="You’re on the list."
        body={`${hostName(view)} will let you in soon.\nYour own music keeps playing until then.`}
        actionLabel="Cancel request"
        pendingLabel="Canceling…"
        variant="secondary"
        action={leave}
      />
    );
  }

  if (view?.state === "ended") {
    return (
      <JamState
        title="Jam ended"
        icon={Music}
        heading="That was a good one."
        body={`${endedLine(view.reason)}\nYour own queue is ready for you.`}
        actionLabel="Back to my music"
        action={leave}
      />
    );
  }

  const joinOther = {
    label: "Join a Jam",
    onPress: () => {
      router.push("/jam/join");
    },
  };

  if (nowPlaying === null) {
    return (
      <JamState
        title="Jam"
        icon={Users}
        heading={"No Jam\nright now."}
        body={"Start one from Now Playing,\nor join someone else’s."}
        actionLabel="Join a Jam"
        action={async () => {
          router.replace("/jam/join");
        }}
      />
    );
  }

  return (
    <JamState
      title="Start a Jam"
      icon={Users}
      heading={"Listen\ntogether."}
      body={`People who open your Jam’s link listen along to ${nowPlaying.title} and your queue.\nTheir own music waits until they leave.`}
      actionLabel="Start a Jam"
      pendingLabel="Starting…"
      action={async () => {
        await start();
      }}
      secondary={joinOther}
    />
  );
}
