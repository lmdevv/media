import { useAuthActions } from "@convex-dev/auth/react";
import { useRead, useRun } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { Skeleton } from "@music/ui/components/skeleton";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { SettingsHeader } from "@/components/settings/settings-ui";
import { useAction } from "@/lib/action";
import { initial } from "@/lib/format";

export const Route = createFileRoute("/_app/settings/account")({ component: AccountSettings });

function AccountSettings() {
  const me = useRead("account.me", {});
  const rename = useRun("account.rename");
  const { signOut } = useAuthActions();
  const navigate = useNavigate();
  const [name, setName] = useState("");

  useEffect(() => {
    if (me !== undefined) setName(me.name ?? "");
  }, [me]);

  const [save, saving] = useAction(() => rename({ name: name.trim() }), {
    success: () => "Saved your name",
  });

  const [leave, leaving] = useAction(async () => {
    await signOut();
    await navigate({ to: "/sign-in" });
  });

  if (me === undefined) return <Skeleton className="h-40 w-full max-w-180 rounded-lg" />;

  const changed = name.trim() !== (me.name ?? "") && name.trim().length > 0;

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
              onChange={(event) => setName(event.target.value)}
              fieldClassName="max-w-90 min-w-0 shrink"
            />
            <Button type="submit" variant="solid" disabled={!changed} pending={saving}>
              Save
            </Button>
          </div>
          <FieldHint>Shown in the sidebar, on invites you send, and in the people list.</FieldHint>
        </div>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-row shrink-0 items-center justify-center rounded-full bg-text font-sans text-md/base font-semibold text-text-inverse">
            {initial(me.name ?? me.email)}
          </span>
          <span className="flex flex-col gap-px">
            <span className="font-sans text-base/sm font-semibold text-text">
              {me.name ?? me.email} · {me.role === "admin" ? "Admin" : "Member"}
            </span>
            <span className="font-sans text-sm/xs text-text-muted">{me.email}</span>
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
