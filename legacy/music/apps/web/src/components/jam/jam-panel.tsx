import type { UserId } from "@music/commands/ids";
import type { Jam, JamEditScope, JamJoinPolicy, JamSettings } from "@music/commands/models";
import { JAM_ADD_LIMIT_MAX } from "@music/commands/models";
import { usePlayer } from "@music/player/react";
import { useRead, useRun } from "@music/sdk/react";
import { Button } from "@music/ui/components/button";
import { Dialog, DialogContent } from "@music/ui/components/dialog";
import { FieldHint, FieldLabel, Input } from "@music/ui/components/input";
import { Segmented } from "@music/ui/components/segmented";
import { Sheet, SheetContent } from "@music/ui/components/sheet";
import { Switch } from "@music/ui/components/switch";
import { CopyIcon, UsersRoundIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { useUi } from "@/components/shell/ui-state";
import { toastFailure, useAction } from "@/lib/action";
import { copyText } from "@/lib/copy-text";
import { plural } from "@/lib/format";
import { useIsDesktop } from "@/lib/use-media";

import { Avatar } from "./avatars";
import { QrCode } from "./qr-code";

/** The link people open to join, on this server's address. */
const jamLink = (code: string): string =>
  new URL(`/jam/${code}`, window.location.origin).toString();

const JOIN_OPTIONS: ReadonlyArray<{ readonly value: JamJoinPolicy; readonly label: string }> = [
  { value: "open", label: "Anyone with the link" },
  { value: "approval", label: "You approve" },
  { value: "locked", label: "Locked" },
];

const EDIT_OPTIONS: ReadonlyArray<{ readonly value: JamEditScope; readonly label: string }> = [
  { value: "none", label: "Nothing" },
  { value: "own", label: "Their own songs" },
  { value: "any", label: "Anything" },
];

const ENDED: Readonly<Record<NonNullable<Jam["endedReason"]>, string>> = {
  host: "The host ended it.",
  host_offline: "The host was offline for half an hour.",
  idle: "Nothing played for four hours.",
};

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <h3 className="font-mono text-xs/xs tracking-mono text-text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** A labelled switch row. */
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

/** No Jam yet: what one is, and the button to start it. */
function StartJam() {
  const start = useRun("jam.start");
  const [run, pending] = useAction(() => start({}), { success: () => "Jam started" });

  return (
    <div className="flex flex-col gap-4">
      <p className="font-sans text-md/md text-text-muted">
        Listen together: people who open your Jam's link share your queue and player. They add songs
        and, if you let them, steer playback. Their own music waits until they leave.
      </p>
      <Button variant="primary" pending={pending} onClick={() => void run()}>
        <UsersRoundIcon />
        Start a Jam
      </Button>
    </div>
  );
}

/** The link to send, with Copy and a QR code to scan from a phone. */
function ShareJam({ jam }: { readonly jam: Jam }) {
  const link = jamLink(jam.code);
  const relink = useRun("jam.relink");

  const [regenerate, regenerating] = useAction(() => relink({}), {
    success: () => "New link made; the old one no longer works",
  });

  // Without a clipboard (a plain-http address) or when the browser refuses, show the link instead.
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
            <Button
              variant="ghost"
              size="sm"
              pending={regenerating}
              onClick={() => void regenerate()}
            >
              New link
            </Button>
          </div>
          <FieldHint>Anyone signed in who has the link can join, as you set below.</FieldHint>
        </div>
      </div>
    </Section>
  );
}

/** Confirms a host action with a toast, or shows why it failed. */
const act = (call: Promise<unknown>, message: string): void => {
  call.then(() => toast.success(message)).catch(toastFailure);
};

/** Who is in the Jam; the host lets people in, turns them away, and removes them. */
function People({ jam }: { readonly jam: Jam }) {
  const approve = useRun("jam.approve");
  const remove = useRun("jam.remove");
  const host = jam.role === "host";

  const joined = jam.members.filter((member) => member.status === "joined");
  const waiting = jam.members.filter((member) => member.status === "pending");

  return (
    <Section
      title={`People · ${String(joined.length + 1)} ${joined.length === 0 ? "person" : "people"}`}
    >
      <ul aria-label="People in the Jam" className="flex flex-col">
        <li className="flex min-h-11 items-center gap-3">
          <Avatar person={jam.host} />
          <span className="grow truncate font-sans text-base/sm text-text">{jam.host.name}</span>
          <span className="font-sans text-sm/xs text-text-muted">Host</span>
        </li>
        {joined.map((member) => (
          <li key={member.person.id} className="flex min-h-11 items-center gap-3">
            <Avatar person={member.person} />
            <span className="grow truncate font-sans text-base/sm text-text">
              {member.person.name}
            </span>
            {member.listening ? (
              <span className="font-sans text-sm/xs text-text-muted">Listening along</span>
            ) : null}
            {host ? (
              <button
                type="button"
                aria-label={`Remove ${member.person.name} from the Jam`}
                onClick={() =>
                  act(
                    remove({ userId: member.person.id }),
                    `Removed ${member.person.name}; this link won't let them back`,
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
          {waiting.map((member) => {
            const userId: UserId = member.person.id;

            return (
              <li key={userId} className="flex min-h-11 items-center gap-3">
                <Avatar person={member.person} className="opacity-(--opacity-muted)" />
                <span className="grow truncate font-sans text-base/sm text-text">
                  {member.person.name}
                  <span className="text-text-muted"> wants to join</span>
                </span>
                <Button
                  variant="solid"
                  size="sm"
                  onClick={() =>
                    act(approve({ userId, approve: true }), `Let ${member.person.name} in`)
                  }
                >
                  Let in
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    act(approve({ userId, approve: false }), `Turned ${member.person.name} away`)
                  }
                >
                  Turn away
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Section>
  );
}

/**
 * The limit on each person's upcoming songs (0 for none). It keeps what is typed as a draft and
 * saves it on blur or Enter, so typing "12" doesn't save 1 first, and clearing the field to type
 * doesn't save "no limit".
 */
function AddLimitField({
  saved,
  onSave,
}: {
  readonly saved: number;
  readonly onSave: (limit: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(saved));

  const commit = () => {
    const limit = Number(draft);

    if (draft.trim() === "" || !Number.isInteger(limit) || limit < 0) {
      setDraft(String(saved));

      return;
    }

    const clamped = Math.min(limit, JAM_ADD_LIMIT_MAX);

    setDraft(String(clamped));

    if (clamped !== saved) onSave(clamped);
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <FieldLabel htmlFor={id}>Upcoming songs each (0 for no limit)</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={JAM_ADD_LIMIT_MAX}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        fieldClassName="w-24"
      />
    </div>
  );
}

/** What people in the Jam may do; only the host sees and changes these. */
function HostSettings({
  settings,
  approvalAfterRemoval,
}: {
  readonly settings: JamSettings;
  readonly approvalAfterRemoval: boolean;
}) {
  const save = useRun("jam.settings");

  const change = (changes: Parameters<typeof save>[0]) => {
    save(changes).catch(toastFailure);
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
        {approvalAfterRemoval ? (
          <FieldHint>
            New people need your OK because you removed someone. Make a new link to let them
            straight in again.
          </FieldHint>
        ) : null}
      </div>
      <Toggle
        label="People can add songs"
        checked={settings.membersCanAdd}
        onChange={(membersCanAdd) => change({ membersCanAdd })}
      />
      {settings.membersCanAdd ? (
        <AddLimitField
          // A new limit from the server starts a fresh draft.
          key={settings.addLimit ?? 0}
          saved={settings.addLimit ?? 0}
          onSave={(addLimit) => change({ addLimit })}
        />
      ) : null}
      <Toggle
        label="People can play, pause, skip, and seek"
        checked={settings.membersCanControl}
        onChange={(membersCanControl) => change({ membersCanControl })}
      />
      <div className="flex flex-col gap-1.5">
        <span className="font-sans text-sm/xs font-medium text-text">
          People can move and remove
        </span>
        <Segmented
          label="People can move and remove"
          value={settings.membersCanEdit}
          options={EDIT_OPTIONS}
          onChange={(membersCanEdit) => change({ membersCanEdit })}
          className="w-fit max-w-full"
        />
      </div>
      <Toggle
        label="People can listen along on their own devices"
        checked={settings.listenAlong}
        onChange={(listenAlong) => change({ listenAlong })}
      />
    </Section>
  );
}

/** Someone in the Jam: listen along here or use it as a remote, and leave. */
function MemberControls({ jam }: { readonly jam: Jam }) {
  const player = usePlayer();
  const listen = useRun("jam.listen");
  // People add songs they can hear themselves; a guest from a Jam link hears no library.
  const libraries = useRead("libraries.list", {});
  const canAddAny = libraries?.some((library) => library.readable) ?? true;
  const here = player.following && player.isThisDevice;

  const toggle = (on: boolean) => {
    const call =
      on && player.deviceId !== null
        ? listen({ on: true, deviceId: player.deviceId })
        : listen({ on: false });

    call.catch(toastFailure);
  };

  return (
    <Section title="You">
      {jam.settings.listenAlong ? (
        <Toggle label="Listen along on this device" checked={here} onChange={toggle} />
      ) : (
        <p className="font-sans text-sm/sm text-text-muted">
          The host plays this Jam on their own device; listening along is off.
        </p>
      )}
      <FieldHint>
        {!canAddAny
          ? "No library is shared with you, so you can't add songs; you can listen along."
          : jam.settings.membersCanAdd
            ? jam.settings.addLimit === null
              ? "You can add songs to the queue."
              : `You can have up to ${plural(jam.settings.addLimit, "song")} coming up.`
            : "The host isn't taking songs right now."}
        {jam.settings.membersCanControl ? " You can also play, pause, and skip." : ""}
      </FieldHint>
    </Section>
  );
}

/** The panel's body for whatever state the viewer's Jam is in. */
function JamBody({ onDone }: { readonly onDone: () => void }) {
  const { jam } = usePlayer();
  const end = useRun("jam.end");
  const leave = useRun("jam.leave");

  const [ending, endPending] = useAction(
    async () => {
      await end({});
      onDone();
    },
    { success: () => "Jam ended" },
  );

  const [leaving, leavePending] = useAction(async () => {
    await leave({});
    onDone();
  });

  if (jam === null) return <StartJam />;

  if (jam.status === "ended") {
    return (
      <div className="flex flex-col gap-4">
        <p className="font-sans text-md/md text-text-muted">
          {jam.endedReason === null ? "" : ENDED[jam.endedReason]} Your own music is back where you
          left it.
        </p>
        <Button variant="solid" pending={leavePending} onClick={() => void leaving()}>
          Back to your music
        </Button>
      </div>
    );
  }

  if (jam.role === "pending") {
    return (
      <div className="flex flex-col gap-4">
        <p className="font-sans text-md/md text-text-muted">
          Waiting for {jam.host.name} to let you in. Your own music keeps playing until then.
        </p>
        <Button variant="ghost" pending={leavePending} onClick={() => void leaving()}>
          Stop waiting
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {jam.role === "host" ? <ShareJam jam={jam} /> : null}
      <People jam={jam} />
      {jam.role === "host" ? (
        <HostSettings settings={jam.settings} approvalAfterRemoval={jam.approvalAfterRemoval} />
      ) : (
        <MemberControls jam={jam} />
      )}
      <div className="flex justify-end">
        {jam.role === "host" ? (
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

const titleOf = (jam: Jam | null): string => {
  if (jam === null) return "Start a Jam";

  if (jam.status === "ended") return "The Jam ended";

  return jam.role === "host" ? "Your Jam" : `${jam.host.name}'s Jam`;
};

/** The Jam panel: a dialog on desktop, a bottom sheet on phones. */
export function JamPanel() {
  const { jamOpen, setJamOpen } = useUi();
  const { jam } = usePlayer();
  const desktop = useIsDesktop();
  const title = titleOf(jam);
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
