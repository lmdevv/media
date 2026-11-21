import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Avatar } from "@media/ui/components/avatar";
import { Button } from "@media/ui/components/button";
import { RadioGroup, RadioItem } from "@media/ui/components/radio-group";
import { Switch } from "@media/ui/components/switch";
import { cn } from "@media/ui/lib/utils";
import { EyeOffIcon, XIcon } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";

import { episodeCode } from "@/lib/format";

import { moviesItem } from "./session";
import type {
  JoinedSession,
  MoviesItem,
  QueueEntry,
  SessionMember,
  SessionSettings,
  WaitingPerson,
} from "./session";

/** Members out of step by more than this see how far, on their own row. */
const SHOWN_DRIFT_MS = 1_000;

/** `-2.4s` or `+1.2s`. */
export const driftLabel = (driftMs: number): string =>
  `${driftMs < 0 ? "-" : "+"}${(Math.abs(driftMs) / 1000).toFixed(1)}s`;

/** What a member's row says at its right edge; members in step say nothing. */
type MemberStatus =
  /** Silent for a while: the tab closed or the connection dropped. Muted rather than a warning. */
  | { readonly kind: "away" }
  /** The viewer is still catching up to the session. */
  | { readonly kind: "syncing" }
  /** The viewer is off the shared position by `label`, such as `-2.4s`. */
  | { readonly kind: "drift"; readonly label: string };

/** A row of the panel's member list. */
export interface MemberRow {
  readonly id: SessionMember["userId"];
  readonly name: string;
  /** `Host`, `You`, `You · Host`, or nothing. */
  readonly detail: string | null;
  readonly status: MemberStatus | null;
}

/**
 * The panel's rows for `members` as `self` sees them: the host first, then the viewer, then
 * everyone else as they joined. `syncing` marks the viewer still catching up; `ownDriftMs` is their
 * latest measured drift. Other members' drift is not shared, so their rows say only who is away.
 */
export const memberRows = (
  members: ReadonlyArray<SessionMember>,
  self: SessionMember["userId"] | null,
  syncing: boolean,
  ownDriftMs: number | null,
): ReadonlyArray<MemberRow> => {
  const rank = (member: SessionMember): number =>
    member.role === "host" ? 0 : member.userId === self ? 1 : 2;

  return members
    .map((member, order) => ({ member, order }))
    .toSorted((left, right) => rank(left.member) - rank(right.member) || left.order - right.order)
    .map(({ member }): MemberRow => {
      const mine = member.userId === self;

      const detail = [mine ? "You" : null, member.role === "host" ? "Host" : null]
        .filter((part) => part !== null)
        .join(" · ");

      return {
        id: member.userId,
        name: member.username,
        detail: detail === "" ? null : detail,
        status: statusOf(member, mine, syncing, ownDriftMs),
      };
    });
};

const statusOf = (
  member: SessionMember,
  mine: boolean,
  syncing: boolean,
  ownDriftMs: number | null,
): MemberStatus | null => {
  if (!member.present) return { kind: "away" };

  if (mine && syncing) return { kind: "syncing" };

  return mine && ownDriftMs !== null && Math.abs(ownDriftMs) > SHOWN_DRIFT_MS
    ? { kind: "drift", label: driftLabel(ownDriftMs) }
    : null;
};

const statusLabel = (status: MemberStatus): string =>
  status.kind === "drift" ? status.label : status.kind;

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h3 className="text-caption/caption font-semibold tracking-caps text-text-muted uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function EntryName({ item }: { readonly item: MoviesItem }) {
  const platform = usePlatform();
  const titleId = item.ref.type === "title" ? item.ref.id : null;
  const episodeId = item.ref.type === "episode" ? item.ref.id : null;

  const title = usePlatformQuery(
    platform.movies.titles.get,
    ...(titleId === null ? (["skip"] as const) : ([{ titleId }] as const)),
  );

  const episode = usePlatformQuery(
    platform.movies.titles.episode,
    ...(episodeId === null ? (["skip"] as const) : ([{ episodeId }] as const)),
  );

  const name =
    title.status === "success"
      ? title.data.name
      : episode.status === "success"
        ? `${episodeCode(episode.data)} · ${episode.data.name}`
        : "…";

  return <span className="truncate text-body/5 font-semibold text-text">{name}</span>;
}

function QueueRow({
  entry,
  onRemove,
}: {
  readonly entry: QueueEntry;
  readonly onRemove: (entryId: QueueEntry["entryId"]) => void;
}) {
  const item = moviesItem(entry.item);

  return (
    <li className="flex items-center gap-3" data-slot="queue-entry">
      <span className="flex min-w-0 grow basis-0 flex-col">
        {item === null ? (
          <span className="flex items-center gap-2 text-body/5 font-semibold text-text-muted">
            <EyeOffIcon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
            Hidden
          </span>
        ) : (
          <EntryName item={item} />
        )}
        {entry.addedBy === null ? null : (
          <span className="truncate text-label/label text-text-muted">
            Added by {entry.addedBy}
          </span>
        )}
      </span>
      {entry.removable ? (
        <button
          type="button"
          aria-label="Take out of Up next"
          onClick={() => onRemove(entry.entryId)}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-pill text-text-muted transition-colors hover:bg-text/10 hover:text-text"
        >
          <XIcon className="size-4" strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

function WaitingRow({
  person,
  onAdmit,
  onTurnAway,
}: {
  readonly person: WaitingPerson;
  readonly onAdmit: () => void;
  readonly onTurnAway: () => void;
}) {
  return (
    <li className="flex items-center gap-3">
      <Avatar name={person.username} round className="size-10" />
      <span className="min-w-0 grow basis-0 truncate text-body/5 font-semibold text-text">
        {person.username}
      </span>
      <Button variant="ghost" size="sm" onClick={onTurnAway}>
        Turn away
      </Button>
      <Button variant="subtle" size="sm" onClick={onAdmit}>
        Let in
      </Button>
    </li>
  );
}

const JOIN_OPTIONS: ReadonlyArray<{
  readonly value: SessionSettings["join"];
  readonly label: string;
}> = [
  { value: "open", label: "Anyone with the link" },
  { value: "approval", label: "Ask me first" },
  { value: "locked", label: "No one new" },
];

const isJoinSetting = (value: unknown): value is SessionSettings["join"] =>
  JOIN_OPTIONS.some((option) => option.value === value);

function Settings({
  settings,
  onChange,
}: {
  readonly settings: SessionSettings;
  readonly onChange: (settings: SessionSettings) => void;
}) {
  const controlId = useId();
  const addId = useId();

  return (
    <>
      <Section title="Who can join">
        <RadioGroup
          value={settings.join}
          onValueChange={(value) => {
            if (isJoinSetting(value)) onChange({ ...settings, join: value });
          }}
          className="gap-3"
        >
          {JOIN_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-3 text-body/5 text-text"
            >
              <RadioItem value={option.value} />
              {option.label}
            </label>
          ))}
        </RadioGroup>
      </Section>
      <Section title="Guests can">
        <label
          htmlFor={controlId}
          className="flex cursor-pointer items-center justify-between gap-3 text-body/5 text-text"
        >
          Pause and seek
          <Switch
            id={controlId}
            checked={settings.control}
            onCheckedChange={(control) => onChange({ ...settings, control })}
          />
        </label>
        <label
          htmlFor={addId}
          className="flex cursor-pointer items-center justify-between gap-3 text-body/5 text-text"
        >
          Add to Up next
          <Switch
            id={addId}
            checked={settings.add}
            onCheckedChange={(add) => onChange({ ...settings, add })}
          />
        </label>
      </Section>
    </>
  );
}

/**
 * The watch-together panel beside the player, or under it on phones held upright: who is watching
 * and who is out of step, who waits to join, what plays next, and for the host who may join and
 * what guests may do. Everyone can copy the link; the host ends the session and guests leave it.
 */
export function SessionPanel({
  session,
  rows,
  paused,
  queue,
  actions,
  className,
}: {
  readonly session: JoinedSession;
  readonly rows: ReadonlyArray<MemberRow>;
  /** The session is paused for everyone; the dot turns amber. */
  readonly paused: boolean;
  readonly queue: ReadonlyArray<QueueEntry>;
  readonly actions: {
    readonly copyLink: () => void;
    readonly leave: () => void;
    readonly configure: (settings: SessionSettings) => void;
    readonly admit: (userId: WaitingPerson["userId"]) => void;
    readonly turnAway: (userId: WaitingPerson["userId"]) => void;
    readonly removeEntry: (entryId: QueueEntry["entryId"]) => void;
  };
  readonly className?: string;
}) {
  const hosting = session.role === "host";
  const waiting = session.pending ?? [];

  return (
    <section
      aria-label="Watching together"
      data-slot="session-panel"
      className={cn(
        "on-media flex flex-col gap-7 overflow-y-auto bg-dark-surface px-6 pt-8 pb-7 font-sans",
        className,
      )}
    >
      <h2 className="flex items-center gap-2 text-heading/heading font-bold text-text">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-pill", paused ? "bg-warning" : "bg-accent")}
        />
        Watching together
      </h2>
      <ul className="flex flex-col gap-5" aria-label="Members">
        {rows.map((member) => (
          <li key={member.id} className="flex items-center gap-3" data-slot="session-member">
            <Avatar
              name={member.name}
              round
              className={cn("size-10", member.status?.kind === "away" && "opacity-35")}
            />
            <span className="flex min-w-0 grow basis-0 flex-col">
              <span className="truncate text-body/5 font-semibold text-text">{member.name}</span>
              {member.detail === null ? null : (
                <span className="truncate text-label/label text-text-muted">{member.detail}</span>
              )}
            </span>
            {member.status === null ? null : (
              <span
                className={cn(
                  "w-18 shrink-0 text-right font-mono text-caption/caption",
                  member.status.kind === "drift" ? "text-warning" : "text-text-muted",
                )}
              >
                {statusLabel(member.status)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {hosting && waiting.length > 0 ? (
        <Section title="Waiting to join">
          <ul className="flex flex-col gap-4">
            {waiting.map((person) => (
              <WaitingRow
                key={person.userId}
                person={person}
                onAdmit={() => actions.admit(person.userId)}
                onTurnAway={() => actions.turnAway(person.userId)}
              />
            ))}
          </ul>
        </Section>
      ) : null}
      {queue.length === 0 ? null : (
        <Section title="Up next">
          <ul className="flex flex-col gap-4">
            {queue.map((entry) => (
              <QueueRow key={entry.entryId} entry={entry} onRemove={actions.removeEntry} />
            ))}
          </ul>
        </Section>
      )}
      {hosting ? <Settings settings={session.settings} onChange={actions.configure} /> : null}
      <div className="mt-auto flex gap-2">
        <Button
          variant="subtle"
          size="md"
          className="flex-1 text-label/caption"
          onClick={actions.copyLink}
        >
          Copy invite link
        </Button>
        <Button
          variant="ghost"
          size="md"
          className="px-3.5 text-label/caption"
          onClick={actions.leave}
        >
          {hosting ? "End session" : "Leave session"}
        </Button>
      </div>
    </section>
  );
}
