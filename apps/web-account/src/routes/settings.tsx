import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Skeleton } from "@media/ui/components/skeleton";
import { FieldError } from "@media/ui/components/text-field";
import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@media/ui/components/page-header";
import { SettingsFrame } from "@/components/shell";
import { describeFailure } from "@media/ui/lib/failure";
import { useAction } from "@/screens/people/action";
import {
  DisplayNameSection,
  NameSection,
  PasswordSection,
  PlaybackSection,
  SharedDevicesSection,
  UnlockCodeSection,
} from "@/screens/people/settings";
import type { SettingsChange } from "@/screens/people/settings";
import { useMe } from "@/session/me";

export const Route = createFileRoute("/settings")({
  staticData: { need: "account" },
  head: () => ({ meta: [{ title: "Settings · [media]" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const platform = usePlatform();
  const me = useMe();
  const { accounts, devices } = platform.core;

  const naming = useAction(async (displayName: string | null) => {
    await accounts.me.setDisplayName({ displayName });
  });

  const rename = useAction(async (username: string) => {
    await accounts.me.rename({ username });
  });

  const password = useAction(
    async (change: { readonly currentPassword: string; readonly newPassword: string }) => {
      await accounts.me.changePassword(change);
    },
  );

  const code = useAction(async (next: string | null) => {
    await devices.unlockCodes.set({ code: next });
  });

  const listing = useAction(async (listed: boolean) => {
    await devices.tiles.setListed({ userId: me.userId, listed });
  });

  const playback = useAction(async (change: SettingsChange) => {
    await platform.core.settings.set(change);
  });

  const restrictions = usePlatformQuery(platform.core.restrictions.get, { userId: me.userId });
  const settings = usePlatformQuery(platform.core.settings.get);

  return (
    <SettingsFrame>
      <PageHeader title="Settings" />
      <DisplayNameSection
        key={me.displayName ?? ""}
        displayName={me.displayName}
        username={me.username}
        status={naming.status}
        onSave={(displayName) => void naming.run(displayName)}
      />
      <NameSection
        key={me.username}
        username={me.username}
        status={rename.status}
        onRename={(username) => void rename.run(username)}
      />
      <PasswordSection status={password.status} onChange={(change) => void password.run(change)} />
      <UnlockCodeSection status={code.status} onSet={(next) => void code.run(next)} />
      {restrictions.status === "success" ? (
        <SharedDevicesSection
          kid={restrictions.data !== null}
          status={listing.status}
          onList={(listed) => void listing.run(listed)}
        />
      ) : null}
      {settings.status === "loading" ? (
        <Skeleton className="h-64 w-full max-w-180 rounded-control" />
      ) : null}
      {settings.status === "error" ? (
        <div className="flex flex-col items-start gap-3">
          <FieldError className="pt-0">{describeFailure(settings.error)}</FieldError>
          <Button variant="ghost" size="sm" onClick={settings.retry}>
            Try again
          </Button>
        </div>
      ) : null}
      {settings.status === "success" ? (
        <PlaybackSection
          settings={settings.data}
          status={playback.status}
          onChange={(change) => void playback.run(change)}
        />
      ) : null}
    </SettingsFrame>
  );
}
