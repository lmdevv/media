import { useHasTrack } from "@media/player/react";
import { fullName, hostName, shownName, useMusicSession } from "@media/player/session-react";
import type { JoinedSession, SessionSettings } from "@media/player/session-react";
import { CopyIcon, UsersRoundIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { useUi } from "@/components/shell/ui-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FieldHint, Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { toastFailure, useAction } from "@/lib/action";
import { useIsDesktop } from "@/lib/use-media";

import { Avatar } from "./avatars";
import { ENDED, jamUrl, useJamActions } from "./jam";
import type { JoinSetting } from "./jam";
import { QrCode } from "./qr-code";

const JOIN_OPTIONS: ReadonlyArray<{ readonly value: JoinSetting; readonly label: string }> = [
  { value: "open", label: "Anyone with the link" },
  { value: "approval", label: "You approve" },
  { value: "locked", label: "Locked" },
];

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <h3 className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-4">
      <span className="font-sans text-base/sm text-text">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function StartJam() {
  const { start, starting } = useMusicSession();
  const hasTrack = useHasTrack();
  const [run, pending] = useAction(start, { success: () => "Jam started" });

  return (
    <div className="flex flex-col gap-4">
      <p className="font-sans text-md/md text-text-muted">
        People who open your Jam's link listen along to your queue and player. They add songs and,
        if you let them, steer playback. Their own music waits until they leave.
      </p>
      <Button
        variant="primary"
        pending={pending || starting}
        disabled={!hasTrack}
        onClick={() => void run()}
      >
        <UsersRoundIcon />
        Start a Jam
      </Button>
    </div>
  );
}

const copyText = async (text: string): Promise<boolean> => {
  if (!window.isSecureContext) return false;

  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    return false;
  }
};

function ShareJam({ jam }: { readonly jam: JoinedSession }) {
  const link = jamUrl(jam.link);

  const copy = async () => {
    if (await copyText(link)) toast.success("Link copied");
    else toast("Jam link", { description: link });
  };

  return (
    <Section title="Invite">
      <div className="flex items-start gap-4">
        <QrCode value={link} label="QR code for the Jam link" className="size-32 shrink-0 p-1" />
        <div className="flex min-w-0 grow flex-col gap-2">
          <Input readOnly aria-label="Jam link" value={link} data-testid="jam-link" />
          <div className="flex flex-wrap gap-2">
            <Button variant="solid" size="sm" className="pl-3" onClick={() => void copy()}>
              <CopyIcon />
              Copy link
            </Button>
          </div>
          <FieldHint>Anyone signed in who has the link can join, as you set below.</FieldHint>
        </div>
      </div>
    </Section>
  );
}

const act = (call: Promise<unknown>, message: string): void => {
  call.then(() => toast.success(message)).catch(toastFailure);
};

function People({ jam }: { readonly jam: JoinedSession }) {
  const { admit, block } = useJamActions();
  const host = jam.role === "host";
  const guests = jam.members.filter((member) => member.role === "guest");
  const waiting = jam.pending ?? [];
  const count = jam.members.length;

  return (
    <Section title={`People · ${String(count)} ${count === 1 ? "person" : "people"}`}>
      <ul aria-label="People in the Jam" className="flex flex-col">
        <li className="flex min-h-11 items-center gap-3">
          <Avatar name={hostName(jam)} />
          <span className="grow truncate font-sans text-base/sm text-text">{hostName(jam)}</span>
          <span className="font-sans text-sm/xs text-text-muted">Host</span>
        </li>
        {guests.map((member) => (
          <li key={member.userId} className="flex min-h-11 items-center gap-3">
            <Avatar name={shownName(member)} />
            <span className="grow truncate font-sans text-base/sm text-text">
              {shownName(member)}
              {member.displayName === null ? null : (
                <span className="text-text-muted"> {member.username}</span>
              )}
            </span>
            {member.present ? null : (
              <span className="font-sans text-sm/xs text-text-muted">Away</span>
            )}
            {host ? (
              <button
                type="button"
                aria-label={`Remove ${fullName(member)} from the Jam`}
                onClick={() =>
                  act(
                    block(member.userId),
                    `Removed ${fullName(member)}; this link won't let them back`,
                  )
                }
                className="font-sans text-sm/xs font-medium text-danger hover:underline"
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {host && waiting.length > 0 ? (
        <ul aria-label="Waiting to join" className="flex flex-col gap-1">
          {waiting.map((person) => (
            <li key={person.userId} className="flex min-h-11 items-center gap-3">
              <Avatar name={shownName(person)} className="opacity-(--opacity-muted)" />
              <span className="grow truncate font-sans text-base/sm text-text">
                {shownName(person)}
                <span className="text-text-muted">
                  {person.displayName === null ? null : ` ${person.username}`} wants to join
                </span>
              </span>
              <Button
                variant="solid"
                size="sm"
                onClick={() => act(admit(person.userId), `Let ${fullName(person)} in`)}
              >
                Let in
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => act(block(person.userId), `Turned ${fullName(person)} away`)}
              >
                Turn away
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function HostSettings({ settings }: { readonly settings: SessionSettings }) {
  const { configure } = useJamActions();

  const change = (changes: Partial<SessionSettings>) => {
    configure({ ...settings, ...changes }).catch(toastFailure);
  };

  return (
    <Section title="Settings">
      <div className="flex flex-col gap-1.5">
        <span className="font-sans text-sm/xs font-medium text-text">Who can join</span>
        <Segmented
          label="Who can join"
          value={settings.join}
          options={JOIN_OPTIONS}
          onChange={(join) => change({ join })}
          className="w-fit max-w-full"
        />
      </div>
      <Toggle
        label="People can add songs"
        checked={settings.add}
        onChange={(add) => change({ add })}
      />
      <Toggle
        label="People can play, pause, skip, and seek"
        checked={settings.control}
        onChange={(control) => change({ control })}
      />
    </Section>
  );
}

function MemberHints({ jam }: { readonly jam: JoinedSession }) {
  return (
    <Section title="You">
      <FieldHint>
        {jam.may.add ? "You can add songs to the queue." : "The host isn't taking songs right now."}
        {jam.may.control ? " You can also play, pause, and skip." : ""}
      </FieldHint>
    </Section>
  );
}

function JamBody({ onDone }: { readonly onDone: () => void }) {
  const { view } = useMusicSession();
  const { leave } = useJamActions();

  const [ending, endPending] = useAction(
    async () => {
      await leave();
      onDone();
    },
    { success: () => "Jam ended" },
  );

  const [leaving, leavePending] = useAction(async () => {
    await leave();
    onDone();
  });

  if (view === undefined || view === null) return <StartJam />;

  if (view.state === "ended") {
    return (
      <div className="flex flex-col gap-4">
        <p className="font-sans text-md/md text-text-muted">
          {ENDED[view.reason]} Your own music is back where you left it.
        </p>
        <Button variant="solid" pending={leavePending} onClick={() => void leaving()}>
          Back to your music
        </Button>
      </div>
    );
  }

  if (view.state === "pending") {
    return (
      <div className="flex flex-col gap-4">
        <p className="font-sans text-md/md text-text-muted">
          Waiting for {hostName(view)} to let you in. Your own music keeps playing until then.
        </p>
        <Button variant="ghost" pending={leavePending} onClick={() => void leaving()}>
          Stop waiting
        </Button>
      </div>
    );
  }

  const host = view.role === "host";

  return (
    <div className="flex flex-col gap-6">
      {host ? <ShareJam jam={view} /> : null}
      <People jam={view} />
      {host ? <HostSettings settings={view.settings} /> : <MemberHints jam={view} />}
      <div className="flex justify-end">
        {host ? (
          <Button variant="danger" pending={endPending} onClick={() => void ending()}>
            End Jam
          </Button>
        ) : (
          <Button variant="danger" pending={leavePending} onClick={() => void leaving()}>
            Leave Jam
          </Button>
        )}
      </div>
    </div>
  );
}

const titleOf = (view: ReturnType<typeof useMusicSession>["view"]): string => {
  if (view === undefined || view === null) return "Start a Jam";

  if (view.state === "ended") return "The Jam ended";

  if (view.state === "pending") return `${hostName(view)}'s Jam`;

  return view.role === "host" ? "Your Jam" : `${hostName(view)}'s Jam`;
};

/** The Jam panel: a dialog on desktop, a bottom sheet on phones, as old music's was. */
export function JamPanel() {
  const { jamOpen, setJamOpen } = useUi();
  const { view } = useMusicSession();
  const desktop = useIsDesktop();
  const title = titleOf(view);
  const close = () => setJamOpen(false);

  if (desktop) {
    return (
      <Dialog open={jamOpen} onOpenChange={setJamOpen}>
        <DialogContent title={title}>
          <JamBody onDone={close} />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={jamOpen} onOpenChange={setJamOpen}>
      <SheetContent title={title}>
        <div className="px-1 pb-2">
          <JamBody onDone={close} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
