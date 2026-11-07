import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Switch } from "@media/ui/components/switch";
import { TextField } from "@media/ui/components/text-field";
import { Match } from "effect";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/shell";
import { describeFailure } from "@/lib/failure";

import { useActions } from "./action";
import { usePages } from "./pages";
import type { Paged } from "./pages";
import { Failed, ItemRow, Muted, Notice, PagedList, Section, formatTime } from "./parts";
import type { GuestLink, GuestStatus, GuestVisit } from "./types";

type LinkId = GuestLink["linkId"];

const STATE_LABELS: Readonly<Record<GuestLink["state"], string>> = {
  open: "Open",
  revoked: "Revoked",
  expired: "Expired",
  dead: "Stopped",
};

const KIND_LABELS: Readonly<Record<GuestLink["kind"], string>> = {
  item: "Item",
  session: "Group session",
};

const DOMAIN_LABELS: Readonly<Record<GuestLink["domain"], string>> = {
  movies: "Movies",
  music: "Music",
};

/** Guests: the switch and address for guest links, and everyone's links with their activity. */
export function GuestsScreen() {
  const platform = usePlatform();
  const status = usePlatformQuery(platform.core.guests.status);

  const links = usePages(platform.core.guests.links.list, (paginationOpts) => ({
    whose: "everyone" as const,
    paginationOpts,
  }));

  const actions = useActions<string>();
  const [open, setOpen] = useState<LinkId | null>(null);

  return (
    <GuestsView
      settings={Match.value(status).pipe(
        Match.discriminatorsExhaustive("status")({
          loading: () => <Muted>Loading…</Muted>,
          error: ({ error, retry }) => <Failed message={describeFailure(error)} retry={retry} />,
          success: ({ data }) => <GuestSettings key={JSON.stringify(data)} saved={data} />,
        }),
      )}
      links={links}
      open={open}
      revoking={actions.running}
      onToggle={(linkId) => setOpen((current) => (current === linkId ? null : linkId))}
      onRevoke={(linkId) =>
        void actions.run(
          linkId,
          () => platform.core.guests.links.revoke({ linkId }),
          "Link revoked",
        )
      }
      activity={(linkId) => <Activity linkId={linkId} />}
    />
  );
}

/** The guests page: settings on top, then every link, each with its activity on demand. */
export function GuestsView({
  settings,
  links,
  open,
  revoking,
  onToggle,
  onRevoke,
  activity,
}: {
  readonly settings: ReactNode;
  readonly links: Paged<GuestLink>;
  readonly open: LinkId | null;
  readonly revoking: string | null;
  readonly onToggle: (linkId: LinkId) => void;
  readonly onRevoke: (linkId: LinkId) => void;
  readonly activity: (linkId: LinkId) => ReactNode;
}) {
  return (
    <>
      <PageHeader title="Guests" />
      {settings}
      <Section title="Everyone's links">
        <PagedList
          label="Everyone's links"
          list={links}
          empty="Nobody has made a guest link."
          rowKey={(link) => link.linkId}
        >
          {(link) => (
            <ItemRow
              title={`${link.madeBy} · ${DOMAIN_LABELS[link.domain]} ${KIND_LABELS[link.kind].toLowerCase()}`}
              facts={`${STATE_LABELS[link.state]} · made ${formatTime(link.madeAt)} · ${
                link.state === "open" ? "ends" : "ended"
              } ${formatTime(link.expiresAt)}`}
              actions={
                <>
                  <Button
                    variant="raised"
                    size="row"
                    aria-expanded={open === link.linkId}
                    onClick={() => onToggle(link.linkId)}
                  >
                    {open === link.linkId ? "Hide activity" : "Activity"}
                  </Button>
                  {link.state === "open" ? (
                    <Button
                      variant="ghost"
                      size="row"
                      disabled={revoking !== null}
                      onClick={() => onRevoke(link.linkId)}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </>
              }
            >
              {open === link.linkId ? activity(link.linkId) : null}
            </ItemRow>
          )}
        </PagedList>
      </Section>
    </>
  );
}

/** The guest-link switch and address as the form edits them. */
export interface GuestDraft {
  readonly enabled: boolean;
  readonly address: string;
}

function GuestSettings({ saved }: { readonly saved: GuestStatus }) {
  const platform = usePlatform();
  const actions = useActions<"save">();

  const [draft, setDraft] = useState<GuestDraft>({
    enabled: saved.enabled,
    address: saved.address ?? "",
  });

  return (
    <GuestSettingsView
      saved={saved}
      draft={draft}
      saving={actions.running === "save"}
      onDraft={setDraft}
      onSave={() => {
        const address = draft.address.trim();

        void actions.run(
          "save",
          () =>
            platform.core.guests.configure({
              enabled: draft.enabled,
              address: address === "" ? null : address,
            }),
          draft.enabled ? "Guest links are on" : "Guest links are off",
        );
      }}
    />
  );
}

/** Guest links on or off, and the address their links use. */
export function GuestSettingsView({
  saved,
  draft,
  saving,
  onDraft,
  onSave,
}: {
  readonly saved: GuestStatus;
  readonly draft: GuestDraft;
  readonly saving: boolean;
  readonly onDraft: (draft: GuestDraft) => void;
  readonly onSave: () => void;
}) {
  const switchId = useId();
  const address = draft.address.trim();
  const unchanged = draft.enabled === saved.enabled && address === (saved.address ?? "");
  const turningOff = saved.enabled && !draft.enabled;

  return (
    <Section title="Guest links">
      <form
        className="flex flex-col gap-4 md:max-w-120"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <label htmlFor={switchId} className="font-sans text-label/label text-text">
            Allow guest links
          </label>
          <Switch
            id={switchId}
            checked={draft.enabled}
            onCheckedChange={(enabled) => onDraft({ ...draft, enabled })}
          />
        </div>
        <TextField
          label="Guest address"
          inputMode="url"
          placeholder="https://media.example.com"
          value={draft.address}
          onChange={(event) => onDraft({ ...draft, address: event.target.value })}
        />
        {turningOff ? <Notice>Every guest link made so far stops working.</Notice> : null}
        <div>
          <Button
            type="submit"
            size="xs"
            disabled={saving || unchanged || (draft.enabled && address === "")}
          >
            Save
          </Button>
        </div>
      </form>
    </Section>
  );
}

function Activity({ linkId }: { readonly linkId: LinkId }) {
  const platform = usePlatform();

  const visits = usePages(platform.core.guests.links.activity, (paginationOpts) => ({
    linkId,
    paginationOpts,
  }));

  return <ActivityView visits={visits} />;
}

/** Who opened a guest link, with the name they gave and when. */
export function ActivityView({ visits }: { readonly visits: Paged<GuestVisit> }) {
  return (
    <div className="rounded-card bg-surface-raised px-4 py-3">
      <PagedList
        label="Guests who opened it"
        list={visits}
        empty="Nobody has opened it."
        rowKey={(visit) => visit.guestId}
      >
        {(visit) => <ItemRow title={visit.name} facts={`opened ${formatTime(visit.openedAt)}`} />}
      </PagedList>
    </div>
  );
}
