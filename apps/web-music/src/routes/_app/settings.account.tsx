import { Button } from "@/components/ui/button";
import { FieldHint, FieldLabel, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { usePlatform } from "@media/sdk/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";

import { SettingsHeader } from "@/components/settings/settings-ui";
import { useAction } from "@/lib/action";
import { ACCOUNT_SETTINGS } from "@/lib/account-links";
import { initial } from "@/lib/format";
import { nameOf, useMe } from "@/lib/platform";
import type { Me } from "@/lib/platform";
import { useSignOut } from "@/session/session";

export const Route = createFileRoute("/_app/settings/account")({ component: AccountSettings });

const ROLE_LABELS: Readonly<Record<Me["role"], string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/**
 * Old music's account settings: the name you go by, and signing out, which ends the browser's one
 * session for every client on this server (D52). The password and the rest of the account live in
 * the account client.
 */
function AccountSettings() {
  const platform = usePlatform();
  const me = useMe();
  const signOut = useSignOut();
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? me?.displayName ?? "";

  const [save, saving] = useAction(
    async () => {
      const submitted = name.trim();

      await platform.core.accounts.me.setDisplayName({ displayName: submitted });
      setDraft((current) => (current?.trim() === submitted ? null : current));
    },
    { success: () => "Saved your name" },
  );

  const [leave, leaving] = useAction(signOut);

  if (me === undefined) return <Skeleton className="h-40 w-full max-w-180 rounded-lg" />;

  const changed = name.trim() !== (me.displayName ?? "") && name.trim().length > 0;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (changed) void save();
  };

  return (
    <div className="flex max-w-180 flex-col gap-7">
      <SettingsHeader title="Account" lead="How you appear to other people on this server." />
      <form onSubmit={submit} className="flex flex-col gap-4 border-b border-border pb-6">
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="display-name">Display name</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="display-name"
              size="md"
              required
              maxLength={120}
              autoComplete="name"
              value={name}
              onChange={(event) => setDraft(event.target.value)}
              fieldClassName="max-w-90 min-w-0 shrink"
            />
            <Button type="submit" variant="solid" disabled={!changed} pending={saving}>
              Save
            </Button>
          </div>
          <FieldHint>
            Shown in the sidebar and in the people list. Your password is in{" "}
            <a href={ACCOUNT_SETTINGS} className="underline">
              account settings
            </a>
            .
          </FieldHint>
        </div>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-row shrink-0 items-center justify-center rounded-full bg-text font-sans text-md/base font-semibold text-text-inverse">
            {initial(nameOf(me))}
          </span>
          <span className="flex flex-col gap-px">
            <span className="font-sans text-base/sm font-semibold text-text">
              {nameOf(me)} · {ROLE_LABELS[me.role]}
            </span>
            <span className="font-sans text-sm/xs text-text-muted">{me.username}</span>
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="font-medium"
          pending={leaving}
          onClick={() => void leave()}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
