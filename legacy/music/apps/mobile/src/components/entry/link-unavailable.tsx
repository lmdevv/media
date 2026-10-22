/**
 * An invite or reset link that can't be used (G08 and its siblings): expired, already used, or
 * not valid. Paper draws the expired invite; the others follow it with their own words. Sign in
 * goes back to Sign in, which every entry link opens over.
 */
import { router } from "expo-router";
import { Clock, Info, KeyRound, Link2Off, UserCheck } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Page } from "@/components/ui/page";
import type { EntryLink } from "@/lib/entry-link";
import type { LinkState } from "@/lib/link-state";

/** Why a link can't be used. */
type Unavailable = Exclude<LinkState, "open">;

/** The links this screen explains; Jam links have their own (G11, G12). */
type AccountLink = Exclude<EntryLink["kind"], "jam">;

interface Copy {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
}

const COPY = {
  invite: {
    expired: {
      icon: Clock,
      title: "This invite\nhas expired.",
      body: "Ask your server admin for a new link.\nAlready have an account? Sign in.",
    },
    used: {
      icon: UserCheck,
      title: "This invite\nwas already used.",
      body: "Each invite link works once.\nIf it was yours, sign in.",
    },
    invalid: {
      icon: Link2Off,
      title: "This invite\nisn’t valid.",
      body: "It may have been revoked or mistyped.\nAsk your server admin for a new link.",
    },
  },
  reset: {
    expired: {
      icon: Clock,
      title: "This link\nhas expired.",
      body: "Reset links last 24 hours.\nAsk your server admin for a new one.",
    },
    used: {
      icon: KeyRound,
      title: "This link\nwas already used.",
      body: "Sign in with your new password,\nor ask your server admin for another link.",
    },
    invalid: {
      icon: Link2Off,
      title: "This link\nisn’t valid.",
      body: "It may have been replaced or mistyped.\nAsk your server admin for a new one.",
    },
  },
} as const satisfies Record<AccountLink, Record<Unavailable, Copy>>;

const TITLES = {
  invite: "Invite",
  reset: "Reset password",
} as const satisfies Record<AccountLink, string>;

/** Back to Sign in, under this screen, or in its place when the link opened at the root. */
const toSignIn = (): void => {
  if (router.canGoBack()) router.back();
  else router.replace("/sign-in");
};

/** Props for `LinkUnavailable`. */
export interface LinkUnavailableProps {
  readonly kind: AccountLink;
  readonly state: Unavailable;
}

/** Why the link can't be used, with Sign in, and for invites another server. */
export function LinkUnavailable({ kind, state }: LinkUnavailableProps) {
  const copy = COPY[kind][state];

  return (
    <Page
      title={TITLES[kind]}
      bottom="plain"
      trailing={
        <View className="size-hit-target items-center justify-center">
          <Icon icon={Info} />
        </View>
      }
    >
      <EmptyState
        icon={copy.icon}
        title={copy.title}
        body={copy.body}
        primary={<Button label="Sign in" onPress={toSignIn} />}
        {...(kind === "invite"
          ? {
              secondary: (
                <Button
                  label="Use another server"
                  variant="secondary"
                  onPress={() => router.replace("/change-server")}
                />
              ),
            }
          : {})}
      />
    </Page>
  );
}
