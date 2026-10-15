import { Button } from "@music/ui/components/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

/** The heading, lead, and optional action at the top of a settings section. */
export function SettingsHeader({
  title,
  lead,
  action,
}: {
  readonly title: string;
  readonly lead: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex max-w-dialog flex-col gap-1">
        <h2 className="font-sans text-lg/md font-semibold tracking-tight text-text">{title}</h2>
        <p className="font-sans text-base/base text-text-muted">{lead}</p>
      </div>
      {action}
    </div>
  );
}

/** A mono label beside a terminal command, used for CLI hints. */
export function TerminalHint({
  label,
  command,
}: {
  readonly label: string;
  readonly command: string;
}) {
  return (
    <div className="flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-surface px-3.5 py-2.5">
      <span className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">{label}</span>
      <code className="font-mono text-sm/xs break-all text-text">{command}</code>
    </div>
  );
}

/** A one-time link to hand over (invite, password reset) with a copy button. */
export function SecretLink({ link, testId }: { readonly link: string; readonly testId: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () =>
    void navigator.clipboard.writeText(link).then(
      () => setCopied(true),
      () => toast.error("Couldn't copy. Select the link and copy it yourself."),
    );

  return (
    <div className="flex h-12 items-center gap-2.5 rounded-sm bg-surface pr-1.5 pl-3.5">
      <code
        data-testid={testId}
        className="min-w-0 grow truncate font-mono text-sm/xs text-text select-all"
      >
        {link}
      </code>
      <Button variant="solid" size="sm" className="h-9 rounded-sm px-3" onClick={copy}>
        {copied ? <CheckIcon strokeWidth={2} /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** Shown in place of a section the viewer's role does not include. */
export function NotForYou({ title, lead }: { readonly title: string; readonly lead: string }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-8">
      <span className="font-sans text-md/base font-semibold text-text">{title}</span>
      <span className="max-w-130 font-sans text-base/base text-text-muted">{lead}</span>
    </div>
  );
}

/** Shown in place of an admin section to members and guests. */
export function AdminOnly() {
  return (
    <NotForYou
      title="Only admins can see this"
      lead="Ask an admin on this server if you need a change here."
    />
  );
}
