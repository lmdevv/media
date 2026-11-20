import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Skeleton } from "@media/ui/components/skeleton";
import { FieldError } from "@media/ui/components/text-field";
import { cn } from "@media/ui/lib/utils";
import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@media/ui/components/page-header";
import { Section } from "@/components/admin/parts";
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

export const Route = createFileRoute("/_you/settings")({
  head: () => ({ meta: [{ title: "Settings · Lar" }] }),
  loader: async ({ context: { platform } }) => {
    // Playback has a skeleton of its own size, so its settings need not hold the page.
    void platform.core.settings.get.preload();
    await preloadRestrictions(platform);
  },
  pendingComponent: SettingsSkeleton,
  component: SettingsPage,
});

/** Preloads the person's own limits, which decide whether Shared devices shows and what it holds. */
const preloadRestrictions = async (platform: PlatformSdk): Promise<void> => {
  const { current } = platform.core.auth.sessions;

  await current.preload();

  const me = current.watch().getSnapshot();

  if (me.status === "success") {
    await platform.core.restrictions.get.preload({ userId: me.data.userId });
  }
};

/** Each section's title and the height of the form under it, top to bottom. */
const SECTIONS = [
  { title: "Name", form: "h-29.5" },
  { title: "Username", form: "h-29.5" },
  { title: "Password", form: "h-58.5" },
  { title: "Unlock code", form: "h-38" },
  { title: "Shared devices", form: "h-17.5" },
] as const;

/** The settings page while its settings load: each section's title over its form's place. */
function SettingsSkeleton() {
  return (
    <>
      <PageHeader title="Settings" />
      {SECTIONS.map(({ title, form }) => (
        <Section key={title} title={title}>
          <Skeleton className={cn("w-full max-w-120 rounded-control", form)} />
        </Section>
      ))}
      <PlaybackSkeleton />
    </>
  );
}

function PlaybackSkeleton() {
  return <Skeleton className="h-64 w-full max-w-180 rounded-control" />;
}

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
    <>
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
      {settings.status === "loading" ? <PlaybackSkeleton /> : null}
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
    </>
  );
}
