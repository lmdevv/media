import { useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Skeleton } from "@media/ui/components/skeleton";

import { useAction } from "@/components/admin/action";
import { formatFullDate } from "@/components/admin/format";
import { PageHeader } from "@/components/admin/page-header";
import { QueryView } from "@/components/admin/query-view";
import { useSignOut } from "@/session/viewer";

const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  service: "Media service",
} as const;

/** Account: who is signed in, their role, and sign-out. */
export function AccountScreen() {
  const viewer = useCommandQuery("account.viewer", {});
  const signOut = useAction(useSignOut());

  return (
    <>
      <PageHeader title="Account" />
      <QueryView
        query={viewer}
        loading={<Skeleton className="h-32 w-full max-w-120 rounded-control" />}
      >
        {({ user }) => (
          <dl className="flex max-w-120 flex-col">
            {[
              ["Name", user.name],
              ["Email", user.email ?? "—"],
              ["Role", ROLE_LABELS[user.role]],
              ["Member since", formatFullDate(user.createdAt)],
            ].map(([label, value]) => (
              <div key={label} className="flex h-11 items-center gap-4">
                <dt className="w-28 shrink-0 font-sans text-label/label text-text-muted">
                  {label}
                </dt>
                <dd className="truncate font-sans text-body/body text-text">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </QueryView>
      <div>
        <Button
          variant="ghost"
          size="sm"
          disabled={signOut.pending}
          onClick={() => void signOut.run()}
        >
          Sign out
        </Button>
      </div>
    </>
  );
}
