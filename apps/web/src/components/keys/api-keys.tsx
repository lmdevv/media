import type { ApiKey, CreatedApiKey } from "@media/contracts/models/account";
import { ApiKeyScope } from "@media/contracts/scopes";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Checkbox } from "@media/ui/components/checkbox";
import { Chip } from "@media/ui/components/chip";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@media/ui/components/dialog";
import { Skeleton } from "@media/ui/components/skeleton";
import { TextField } from "@media/ui/components/text-field";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { useAction } from "@/components/admin/action";
import { CopyField } from "@/components/admin/copy-field";
import { formatAgo, formatDate, formatFullDate } from "@/components/admin/format";
import { Notice } from "@/components/admin/notice";
import { PageHeader } from "@/components/admin/page-header";
import { Cell, Column, Table, TableHead, TableRow } from "@/components/admin/table";
import { useNow } from "@/lib/use-now";
import { useScopes } from "@/session/viewer";

import { ScopeBadges } from "./scope-badge";
import { SCOPE_DESCRIPTIONS, sortScopes } from "./scopes";
import { QueryView } from "@/components/admin/query-view";

const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRY_CHOICES = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Never", days: null },
] as const;

type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

const API_KEY_SCOPES = ApiKeyScope.literals;

/**
 * API keys: the account's keys with their scopes and use, Create key, and revoke. Whether Create key
 * is open lives in the URL, so links and the command menu can open it.
 */
export function ApiKeysScreen({
  creating,
  onCreatingChange: setCreating,
}: {
  readonly creating: boolean;
  readonly onCreatingChange: (open: boolean) => void;
}) {
  const keys = useCommandQuery("apiKeys.list", {});
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const now = useNow(30_000);

  return (
    <>
      <PageHeader
        title="API keys"
        actions={
          <Button onClick={() => setCreating(true)} className="h-10 pr-5.5 pl-4.5 text-body/label">
            <PlusIcon strokeWidth={2} aria-hidden />
            Create key
          </Button>
        }
      />
      <QueryView query={keys} loading={<Skeleton className="h-40 w-full rounded-control" />}>
        {(list) => (
          <KeysTable
            keys={list.filter((key) => key.revokedAt === null)}
            now={now}
            onRevoke={setRevoking}
          />
        )}
      </QueryView>
      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(result) => {
          setCreating(false);
          setCreated(result);
        }}
      />
      <KeyCreatedDialog created={created} onClose={() => setCreated(null)} />
      <RevokeKeyDialog apiKey={revoking} now={now} onClose={() => setRevoking(null)} />
    </>
  );
}

function KeysTable({
  keys,
  now,
  onRevoke,
}: {
  readonly keys: ReadonlyArray<ApiKey>;
  readonly now: number;
  readonly onRevoke: (key: ApiKey) => void;
}) {
  return (
    <Table label="API keys" ruled>
      <TableHead>
        <Column className="w-63">Name</Column>
        <Column className="w-31">Key</Column>
        <Column className="min-w-40 flex-1">Scopes</Column>
        <Column className="w-16">Created</Column>
        <Column className="w-22">Last used</Column>
        <Column className="w-16" />
      </TableHead>
      {keys.length === 0 ? (
        <p className="py-4 font-sans text-body/body text-text-muted">No API keys.</p>
      ) : (
        keys.map((key) => (
          <KeyRow key={key.id} apiKey={key} now={now} onRevoke={() => onRevoke(key)} />
        ))
      )}
    </Table>
  );
}

const lastUsedLabel = (key: ApiKey, now: number): string => {
  if (key.expiresAt !== null && key.expiresAt <= now) return "Expired";

  return key.lastUsedAt === null ? "Never" : formatAgo(key.lastUsedAt, now);
};

function KeyRow({
  apiKey,
  now,
  onRevoke,
}: {
  readonly apiKey: ApiKey;
  readonly now: number;
  readonly onRevoke: () => void;
}) {
  const recent = apiKey.lastUsedAt !== null && now - apiKey.lastUsedAt < 30 * DAY_MS;

  return (
    <TableRow>
      <Cell className="w-63 truncate font-sans text-body/body font-medium text-text">
        {apiKey.name}
      </Cell>
      <Cell className="w-31 truncate font-mono text-label/label text-text-muted">
        {apiKey.prefix}…
      </Cell>
      <Cell className="min-w-40 flex-1">
        <ScopeBadges scopes={sortScopes(apiKey.scopes)} />
      </Cell>
      <Cell className="w-16 font-sans text-label/label text-text-muted">
        {formatDate(apiKey.createdAt, now)}
      </Cell>
      <Cell
        className={
          recent
            ? "w-22 font-sans text-label/label text-text"
            : "w-22 font-sans text-label/label text-text-muted"
        }
      >
        {lastUsedLabel(apiKey, now)}
      </Cell>
      <Cell className="flex w-16 justify-end">
        <button
          type="button"
          onClick={onRevoke}
          aria-label={`Revoke ${apiKey.name}`}
          className="cursor-pointer font-sans text-label/label font-semibold text-text hover:text-danger"
        >
          Revoke
        </button>
      </Cell>
    </TableRow>
  );
}

const expiryDate = (choice: ExpiryChoice, now: number): number | null =>
  choice.days === null ? null : now + choice.days * DAY_MS;

const untilLabel = (expiresAt: number | null): string =>
  expiresAt === null ? "never expires" : `until ${formatFullDate(expiresAt)}`;

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (created: CreatedApiKey) => void;
}) {
  const held = useScopes();
  const create = useCommand("apiKeys.create");
  const now = useNow(30_000);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlyArray<ApiKeyScope>>(["read", "play"]);
  const [expiry, setExpiry] = useState<ExpiryChoice>(EXPIRY_CHOICES[1]);
  const grantable = API_KEY_SCOPES.filter((scope) => held.has(scope));
  const chosen = scopes.filter((scope) => grantable.includes(scope));

  const action = useAction(
    () =>
      create(
        expiry.days === null
          ? { name: name.trim(), scopes: chosen }
          : { name: name.trim(), scopes: chosen, expiresInDays: expiry.days },
      ),
    { quiet: true },
  );

  const reset = (): void => {
    setName("");
    setScopes(["read", "play"]);
    setExpiry(EXPIRY_CHOICES[1]);
    action.reset();
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const result = await action.run();

    if (result !== undefined) {
      reset();
      onCreated(result);
    }
  };

  const toggle = (scope: ApiKeyScope, on: boolean): void =>
    setScopes((current) =>
      on
        ? [...current.filter((each) => each !== scope), scope]
        : current.filter((each) => each !== scope),
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();

        onOpenChange(next);
      }}
    >
      <DialogContent title="Create API key">
        <form onSubmit={(event) => void submit(event)}>
          <DialogBody>
            <TextField
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              autoComplete="off"
              error={action.error}
            />
            <fieldset className="flex flex-col">
              <legend className="pb-1.5 font-sans text-label/caption font-medium text-text-muted">
                Scopes
              </legend>
              {grantable.map((scope) => (
                <label key={scope} className="flex h-10 shrink-0 cursor-pointer items-center gap-3">
                  <Checkbox
                    checked={chosen.includes(scope)}
                    onCheckedChange={(checked) => toggle(scope, checked)}
                  />
                  <span className="w-28 shrink-0 font-mono text-label/label text-text">
                    {scope}
                  </span>
                  <span className="font-sans text-label/label text-text-muted">
                    {SCOPE_DESCRIPTIONS[scope]}
                  </span>
                </label>
              ))}
            </fieldset>
            <div role="radiogroup" aria-label="Expires" className="flex flex-col gap-2">
              <span className="font-sans text-label/caption font-medium text-text-muted">
                Expires
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {EXPIRY_CHOICES.map((choice) => (
                  <Chip
                    key={choice.label}
                    role="radio"
                    aria-checked={choice === expiry}
                    selected={choice === expiry}
                    onClick={() => setExpiry(choice)}
                  >
                    {choice.label}
                  </Chip>
                ))}
                <span className="pl-2 font-mono text-caption/caption text-text-muted">
                  {untilLabel(expiryDate(expiry, now))}
                </span>
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="dialog" />}>Cancel</DialogClose>
            <Button
              type="submit"
              size="dialog"
              disabled={action.pending || chosen.length === 0 || name.trim().length === 0}
            >
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KeyCreatedDialog({
  created,
  onClose,
}: {
  readonly created: CreatedApiKey | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open={created !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {created === null ? null : (
        <DialogContent title="Copy your new key">
          <DialogBody>
            <Notice outlined>You won’t see this key again. Copy it now.</Notice>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-4">
                <span className="truncate font-sans text-label/caption font-medium text-text-muted">
                  {created.apiKey.name}
                </span>
                <span className="shrink-0 font-mono text-caption/caption text-text-muted">
                  {[
                    ...sortScopes(created.apiKey.scopes),
                    untilLabel(created.apiKey.expiresAt),
                  ].join(" · ")}
                </span>
              </div>
              <CopyField value={created.secret} label="New API key" />
            </div>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button size="dialog" />}>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

function RevokeKeyDialog({
  apiKey,
  now,
  onClose,
}: {
  readonly apiKey: ApiKey | null;
  readonly now: number;
  readonly onClose: () => void;
}) {
  const revoke = useCommand("apiKeys.revoke");

  const action = useAction(
    async (target: ApiKey) => {
      await revoke({ apiKeyId: target.id });

      return target;
    },
    { success: (target) => `Revoked ${target.name}`, onSuccess: onClose },
  );

  return (
    <Dialog
      open={apiKey !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {apiKey === null ? null : (
        <DialogContent title={`Revoke “${apiKey.name}”?`} size="sm">
          <DialogBody className="gap-5">
            <p className="font-sans text-body/body text-text-muted">
              Anything using this key stops working right away.
            </p>
            <dl className="flex flex-col rounded-control bg-surface-raised px-3.5 py-2">
              <Fact label="Key" mono>
                {apiKey.prefix}…
              </Fact>
              <Fact label="Scopes" mono>
                {sortScopes(apiKey.scopes).join(" · ")}
              </Fact>
              <Fact label="Last used">{lastUsedLabel(apiKey, now)}</Fact>
            </dl>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="dialog" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              size="dialog"
              disabled={action.pending}
              onClick={() => void action.run(apiKey)}
            >
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

function Fact({
  label,
  mono = false,
  children,
}: {
  readonly label: string;
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex h-8.5 shrink-0 items-center justify-between gap-4">
      <dt className="font-sans text-label/label text-text-muted">{label}</dt>
      <dd
        className={
          mono
            ? "truncate font-mono text-label/label text-text"
            : "truncate font-sans text-label/label text-text"
        }
      >
        {children}
      </dd>
    </div>
  );
}
