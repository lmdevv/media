import type { ApiKey } from "@music/commands/models";
import { useRead, useRun } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@music/ui/components/dialog";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { Skeleton } from "@music/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon, CopyIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { SettingsHeader, TerminalHint } from "@/components/settings/settings-ui";
import { resolveConvexUrl } from "@/config";
import { cliLoginBase, cliLoginCommand, needsInsecure } from "@/lib/cli-login";
import { useAction } from "@/lib/action";
import { formatAgo, formatDate } from "@/lib/format";

/** The URL the CLI signs in to: the Convex URL, not the web app's address. */
const serverUrl = resolveConvexUrl();

const insecure = needsInsecure(serverUrl);

export const Route = createFileRoute("/_app/settings/keys")({ component: KeysSettings });

const RECENT_MS = 10 * 60_000;

function KeysSettings() {
  const keys = useRead("keys.list", {});
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <SettingsHeader
        title="API keys"
        lead="Keys let the CLI and agents act as you: play, search, build playlists, organize files. Revoke any key at any time."
        action={
          <Button variant="solid" className="pr-4.5 pl-3.5" onClick={() => setCreating(true)}>
            <PlusIcon strokeWidth={2} />
            New key
          </Button>
        }
      />
      {keys === undefined ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : keys.length === 0 ? (
        <div className="flex flex-col items-start gap-2.5 rounded-lg border border-dashed border-border p-8">
          <span className="font-sans text-md/base font-semibold text-text">No keys yet</span>
          <span className="max-w-130 font-sans text-base/base text-text-muted">
            Create one for each agent or machine, so you can see what used it and revoke just that
            one.
          </span>
        </div>
      ) : (
        <div role="table" aria-label="API keys" className="flex flex-col overflow-x-auto">
          <div
            role="row"
            className="flex h-8 shrink-0 items-center gap-4 border-b border-border px-3"
          >
            <span
              role="columnheader"
              className="min-w-40 grow basis-0 font-mono text-xs/xs tracking-mono text-text-muted"
            >
              NAME
            </span>
            <span
              role="columnheader"
              className="w-30 shrink-0 font-mono text-xs/xs tracking-mono text-text-muted"
            >
              KEY
            </span>
            <span
              role="columnheader"
              className="hidden w-30 shrink-0 font-mono text-xs/xs tracking-mono text-text-muted md:block"
            >
              CREATED
            </span>
            <span
              role="columnheader"
              className="hidden w-35 shrink-0 font-mono text-xs/xs tracking-mono text-text-muted md:block"
            >
              LAST USED
            </span>
            <span aria-hidden className="w-18 shrink-0" />
          </div>
          {keys.map((key) => (
            <KeyRow key={key.id} apiKey={key} />
          ))}
        </div>
      )}
      <div className="flex flex-col items-start gap-2">
        <TerminalHint label="Use a key" command={cliLoginCommand(serverUrl)} />
        <p className="max-w-130 font-sans text-sm/sm text-text-muted">
          Keep keys off the command line. Pipe the key in as above, set{" "}
          <code className="font-mono text-text">MUSIC_SERVER</code> and{" "}
          <code className="font-mono text-text">MUSIC_API_KEY</code>
          {insecure ? (
            <>
              {" "}
              (with <code className="font-mono text-text">MUSIC_INSECURE=1</code>)
            </>
          ) : null}
          , or run <code className="font-mono text-text">{cliLoginBase(serverUrl)}</code> and paste
          it at the hidden prompt.
          {insecure
            ? " This server is plain http:// on another machine, so the key travels unencrypted; the CLI asks you to confirm that with --insecure."
            : ""}
        </p>
      </div>
      <NewKeyDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function KeyRow({ apiKey }: { readonly apiKey: ApiKey }) {
  const revoke = useRun("keys.revoke");
  const [confirming, setConfirming] = useState(false);
  const recent = apiKey.lastUsedAt !== null && Date.now() - apiKey.lastUsedAt < RECENT_MS;

  const [submit, pending] = useAction(
    async () => {
      await revoke({ apiKeyId: apiKey.id });
      setConfirming(false);
    },
    { success: () => `Revoked ${apiKey.name}` },
  );

  return (
    <div
      role="row"
      className="flex h-row-touch shrink-0 items-center gap-4 border-b border-border px-3"
    >
      <span role="cell" className="flex min-w-40 grow basis-0 items-center gap-2.5">
        <KeyRoundIcon aria-hidden className="size-4.5 shrink-0 text-text" />
        <span className="truncate font-sans text-base/sm font-medium text-text">{apiKey.name}</span>
      </span>
      <span role="cell" className="w-30 shrink-0 truncate font-mono text-sm/xs text-text-muted">
        {apiKey.prefix}…
      </span>
      <span
        role="cell"
        className="hidden w-30 shrink-0 font-sans text-sm/xs text-text-muted md:block"
      >
        {formatDate(apiKey.createdAt)}
      </span>
      <span role="cell" className="hidden w-35 shrink-0 items-center gap-1.5 md:flex">
        {recent ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" /> : null}
        <span
          className={
            recent ? "font-sans text-sm/xs text-text" : "font-sans text-sm/xs text-text-muted"
          }
        >
          {apiKey.lastUsedAt === null ? "Never" : formatAgo(apiKey.lastUsedAt)}
        </span>
      </span>
      <span role="cell" className="flex w-18 shrink-0 justify-end">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="font-sans text-sm/xs font-medium text-danger hover:underline"
        >
          Revoke
        </button>
      </span>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          title={`Revoke ${apiKey.name}?`}
          description="Anything using this key stops working at once. You can create a new key any time."
        >
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button variant="danger" pending={pending} onClick={() => void submit()}>
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewKeyDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const create = useRun("keys.create");
  const [name, setName] = useState("");

  const [created, setCreated] = useState<{ readonly key: string; readonly name: string } | null>(
    null,
  );

  const [copied, setCopied] = useState(false);

  const [submit, pending] = useAction(async () => {
    const result = await create({ name: name.trim() });
    setCreated({ key: result.key, name: result.apiKey.name });
  });

  const close = (next: boolean) => {
    onOpenChange(next);

    if (!next) {
      setCreated(null);
      setName("");
      setCopied(false);
    }
  };

  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy. Select the key and copy it yourself.");
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (name.trim().length > 0) void submit();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      {created === null ? (
        <DialogContent
          title="New API key"
          description="Name it after the agent or machine that will use it."
        >
          <form className="flex flex-col gap-6" onSubmit={onSubmit}>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor="key-name">Name</FieldLabel>
              <Input
                id="key-name"
                required
                maxLength={120}
                autoComplete="off"
                placeholder="claude-code · MacBook"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldHint>The key is shown once, right after you create it.</FieldHint>
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
              <Button
                type="submit"
                variant="solid"
                disabled={name.trim().length === 0}
                pending={pending}
              >
                Create key
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : (
        <DialogContent
          title="Copy your new key"
          description="This is the only time it's shown. Store it in your agent's secrets or a password manager."
          showClose={false}
          className="shadow-none"
        >
          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-sm/xs font-medium text-text">{created.name}</span>
            <div className="flex h-12 items-center gap-2.5 rounded-sm bg-surface pr-1.5 pl-3.5">
              <code
                data-testid="new-api-key"
                className="min-w-0 grow truncate font-mono text-sm/xs text-text select-all"
              >
                {created.key}
              </code>
              <Button
                variant="solid"
                size="sm"
                className="h-9 rounded-sm px-3"
                onClick={() => void copy(created.key)}
              >
                {copied ? <CheckIcon strokeWidth={2} /> : <CopyIcon />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="solid" onClick={() => close(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
