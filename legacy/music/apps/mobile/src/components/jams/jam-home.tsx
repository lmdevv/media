/**
 * The Jam screen for whoever opens it: the host's (D02), a member's (D08), waiting to be let in
 * (D06), ended under a member (D11), or turned away. It follows `jam.get` live, so being let in,
 * turned away, or the host ending the Jam changes the screen on its own.
 */
import type { Jam } from "@music/commands/models";
import { errorMessage } from "@music/sdk/errors";
import { useRead, useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { Clock, Music, UserX, Users } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Page } from "@/components/ui/page";
import { Text } from "@/components/ui/text";
import { endedLine, jamScreen } from "@/lib/jam";

import { HostJam } from "./host-jam";
import { MemberJam } from "./member-jam";

/** Paper's decorative users glyph in the nav bar of the joining screens. */
export const jamNavGlyph = (
  <View className="size-hit-target items-center justify-center">
    <Icon icon={Users} />
  </View>
);

/** Back to the tabs, where the person's own music is. */
export const backToMyMusic = (): void => {
  router.dismissAll();
};

/** A Jam state with one way out: an icon, two lines, and a button that runs `action`. */
function JamState({
  title,
  icon,
  heading,
  body,
  actionLabel,
  pendingLabel,
  variant = "primary",
  action,
}: {
  readonly title: string;
  readonly icon: typeof Users;
  readonly heading: string;
  readonly body: string;
  readonly actionLabel: string;
  readonly pendingLabel?: string;
  readonly variant?: "primary" | "secondary";
  readonly action: () => Promise<void> | void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async () => {
    setPending(true);
    setFailure(null);

    try {
      await action();
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Something went wrong. Try again.");
      setPending(false);
    }
  };

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
            onPress={() => void run()}
          />
        }
      />
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-2 text-center">
          {failure}
        </Text>
      )}
    </Page>
  );
}

/** The Jam screen, by where the person stands in their Jam. */
export function JamHome() {
  const jam = useRead("jam.get", {});
  const leave = useRun("jam.leave");
  const [last, setLast] = useState<Jam | null>(null);
  const [leaving, setLeaving] = useState(false);

  // The last Jam seen, so a Jam that disappears can say why (turned away or removed).
  if (jam !== undefined && jam !== null && jam !== last) setLast(jam);

  const screen = jamScreen(jam, last, leaving);

  /** Leaves the Jam, then goes back to the person's own music. */
  const leaveJam = async () => {
    setLeaving(true);

    try {
      await leave({});
    } catch (cause) {
      setLeaving(false);
      throw cause;
    }

    backToMyMusic();
  };

  if (screen.kind === "loading") {
    return (
      <Page title="" bottom="plain">
        {null}
      </Page>
    );
  }

  if (screen.kind === "host") return <HostJam jam={screen.jam} />;

  if (screen.kind === "member") return <MemberJam jam={screen.jam} onLeave={leaveJam} />;

  if (screen.kind === "waiting") {
    return (
      <JamState
        title="Join a Jam"
        icon={Clock}
        heading="You’re on the list."
        body={`${screen.jam.host.name} will let you in soon.\nKeep this screen open.`}
        actionLabel="Cancel request"
        pendingLabel="Canceling…"
        variant="secondary"
        action={async () => {
          await leaveJam();
        }}
      />
    );
  }

  if (screen.kind === "ended") {
    return (
      <JamState
        title="Jam ended"
        icon={Music}
        heading="That was a good one."
        body={`${endedLine(screen.jam)}\nYour own queue is ready for you.`}
        actionLabel="Back to my music"
        action={leaveJam}
      />
    );
  }

  if (screen.kind === "declined") {
    return (
      <JamState
        title="Join a Jam"
        icon={UserX}
        heading={"Not this\ntime."}
        body={`${screen.hostName} didn’t let you in.\nAsk them for a new link.`}
        actionLabel="Back to my music"
        action={backToMyMusic}
      />
    );
  }

  if (screen.kind === "removed") {
    return (
      <JamState
        title="Jam"
        icon={UserX}
        heading={"You’re out\nof the Jam."}
        body={`${screen.hostName} removed you.\nYour own queue is ready for you.`}
        actionLabel="Back to my music"
        action={backToMyMusic}
      />
    );
  }

  return (
    <JamState
      title="Jam"
      icon={Users}
      heading={"No Jam\nright now."}
      body={"Start one from Now Playing,\nor join someone else’s."}
      actionLabel="Join a Jam"
      action={() => {
        router.replace("/jam/join");
      }}
    />
  );
}
