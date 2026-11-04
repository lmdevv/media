import type { SessionInfo } from "@media/contracts/models/account";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@media/ui/components/dialog";
import { Skeleton } from "@media/ui/components/skeleton";
import { useState } from "react";

import { useAction } from "@/components/admin/action";
import { formatDate, formatUntil } from "@/components/admin/format";
import { PageHeader } from "@/components/admin/page-header";
import { Cell, Column, Table, TableHead, TableRow } from "@/components/admin/table";
import { useNow } from "@/lib/use-now";

import { ScopeBadges } from "./scope-badge";
import { sortScopes } from "./scopes";
import { QueryView } from "@/components/admin/query-view";

const KIND_LABELS: Readonly<Record<SessionInfo["kind"], string>> = {
  password: "Browser",
  apikey: "API key",
  device: "Device",
};

const sessionName = (session: SessionInfo): string =>
  session.label ?? (session.current ? "This browser" : "Browser");

/** Devices: every signed-in browser, device, and API key session, with sign-out for each. */
export function DevicesScreen() {
  const sessions = useCommandQuery("sessions.list", {});
  const [revoking, setRevoking] = useState<SessionInfo | null>(null);
  const now = useNow(30_000);

  return (
    <>
      <PageHeader title="Devices" />
      <QueryView query={sessions} loading={<Skeleton className="h-40 w-full rounded-control" />}>
        {(list) => (
          <Table label="Signed-in devices" ruled>
            <TableHead>
              <Column className="w-63">Name</Column>
              <Column className="w-22">Kind</Column>
              <Column className="min-w-40 flex-1">Scopes</Column>
              <Column className="w-22">Signed in</Column>
              <Column className="w-22">Expires</Column>
              <Column className="w-18" />
            </TableHead>
            {list.map((session) => (
              <TableRow key={session.id}>
                <Cell className="w-63 truncate font-sans text-body/body font-medium text-text">
                  {sessionName(session)}
                </Cell>
                <Cell className="w-22 font-sans text-label/label text-text-muted">
                  {KIND_LABELS[session.kind]}
                </Cell>
                <Cell className="min-w-40 flex-1">
                  <ScopeBadges
                    scopes={sortScopes(session.scopes.filter((scope) => scope !== "media-service"))}
                  />
                </Cell>
                <Cell className="w-22 font-sans text-label/label text-text-muted">
                  {formatDate(session.createdAt, now)}
                </Cell>
                <Cell className="w-22 font-sans text-label/label text-text-muted">
                  {formatUntil(session.expiresAt, now)}
                </Cell>
                <Cell className="flex w-18 justify-end">
                  {session.current ? (
                    <span className="font-sans text-label/label text-text-muted">Current</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRevoking(session)}
                      aria-label={`Sign out ${sessionName(session)}`}
                      className="cursor-pointer font-sans text-label/label font-semibold text-text hover:text-danger"
                    >
                      Sign out
                    </button>
                  )}
                </Cell>
              </TableRow>
            ))}
          </Table>
        )}
      </QueryView>
      <SignOutDialog session={revoking} onClose={() => setRevoking(null)} />
    </>
  );
}

function SignOutDialog({
  session,
  onClose,
}: {
  readonly session: SessionInfo | null;
  readonly onClose: () => void;
}) {
  const revoke = useCommand("sessions.revoke");

  const action = useAction(
    async (target: SessionInfo) => {
      await revoke({ sessionId: target.id });

      return target;
    },
    { success: (target) => `Signed out ${sessionName(target)}`, onSuccess: onClose },
  );

  return (
    <Dialog
      open={session !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {session === null ? null : (
        <DialogContent title={`Sign out “${sessionName(session)}”?`} size="sm">
          <DialogBody>
            <p className="font-sans text-body/body text-text-muted">
              {session.kind === "apikey"
                ? "The key signs in again the next time it is used. Revoke the key to stop it."
                : "It has to sign in again to keep watching."}
            </p>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="dialog" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              size="dialog"
              disabled={action.pending}
              onClick={() => void action.run(session)}
            >
              Sign out
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
