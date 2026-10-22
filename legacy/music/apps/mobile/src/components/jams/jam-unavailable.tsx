/**
 * A Jam link that can't be joined: the host paused new joins (G11), the link was replaced or never
 * worked (G12), or the Jam is over. Signed in, the way out is the person's own music; signed out
 * (D07's route), it is Sign in.
 */
import type { JamPreview } from "@music/sdk/functions";
import { router } from "expo-router";
import { Info, Lock, Music, Users } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/ui/empty-state";
import { Page } from "@/components/ui/page";

import { backToMyMusic } from "./jam-home";

/** Paper's decorative info glyph in the nav bar of page 19's states. */
const infoGlyph = (
  <View className="size-hit-target items-center justify-center">
    <Icon icon={Info} />
  </View>
);

/** Why the link can't be joined. */
type Unavailable = "locked" | "invalid" | "ended";

interface Copy {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: (host: string) => string;
}

const COPY = {
  locked: {
    icon: Lock,
    title: "The host has\npaused new joins.",
    body: (host) => `${host} has paused new joins.\nAsk the host to let you in.`,
  },
  invalid: {
    icon: Users,
    title: "A new link,\na fresh start.",
    body: () => "This link may have been replaced.\nAsk the host for the current one.",
  },
  ended: {
    icon: Music,
    title: "This Jam\nhas ended.",
    body: () => "The host ended it, or it went quiet.\nAsk them to start a new one.",
  },
} as const satisfies Record<Unavailable, Copy>;

/** Whether `preview` says the link can't be joined, and why. */
export const unavailableOf = (preview: JamPreview): Unavailable | null =>
  preview.state === "open" || preview.state === "approval" ? null : preview.state;

/** Back to Sign in, under this screen, or in its place when the link opened at the root. */
const toSignIn = (): void => {
  if (router.canGoBack()) router.back();
  else router.replace("/sign-in");
};

/** Props for `JamUnavailable`. */
export interface JamUnavailableProps {
  readonly state: Unavailable;
  readonly hostName: string;
  readonly signedIn: boolean;
  /** G11's Try again: asks to join once more. */
  readonly retry?: ReactNode;
}

/** Why the Jam link can't be joined, and the ways out. */
export function JamUnavailable({ state, hostName, signedIn, retry }: JamUnavailableProps) {
  const copy = COPY[state];

  const home = (variant: "primary" | "secondary") =>
    signedIn ? (
      <Button label="Back to my music" variant={variant} onPress={backToMyMusic} />
    ) : (
      <Button label="Sign in" variant={variant} onPress={toSignIn} />
    );

  const enterCode = (
    <Button
      label="Enter a Jam code"
      onPress={() => {
        router.replace("/jam/join");
      }}
    />
  );

  // G11 retries and G12 offers a code before the way home; otherwise home is the only way out.
  let primary: ReactNode = null;

  if (state === "locked" && retry !== undefined) primary = retry;
  else if (state === "invalid" && signedIn) primary = enterCode;

  return (
    <Page title="Join a Jam" bottom="plain" trailing={infoGlyph}>
      {primary === null ? (
        <EmptyState
          icon={copy.icon}
          title={copy.title}
          body={copy.body(hostName)}
          primary={home("primary")}
        />
      ) : (
        <EmptyState
          icon={copy.icon}
          title={copy.title}
          body={copy.body(hostName)}
          primary={primary}
          secondary={home("secondary")}
        />
      )}
    </Page>
  );
}
