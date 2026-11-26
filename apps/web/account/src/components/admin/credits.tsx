import { MAX_CREDIT_OVERRIDES, staysWhole } from "@media/contracts/artist-credits";
import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
} from "@media/ui/components/dialog";
import { PageHeader } from "@/components/page-header";
import { RadioGroup, RadioItem } from "@media/ui/components/radio-group";
import { preloadFirstPage, useAllPages, usePages } from "@media/ui/lib/pages";
import type { PageOpts, Paged } from "@media/ui/lib/pages";
import { Link } from "@tanstack/react-router";
import { Match } from "effect";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { useActions } from "./action";
import { LibrariesCrumb, libraryStateOf } from "./library";
import type { LibraryState } from "./library";
import { Failed, ItemRow, ListSkeleton, Muted, Notice, PagedList, Section } from "./parts";
import type { Correction, CorrectionMode, Credit, LibraryDetail, LibraryId } from "./types";

/** Credits asked for per page; the server answers at most 200. */
const CREDITS_PAGE = 100;

/** The arguments for each page of a library's credits or of its corrections. */
const creditArgs = (libraryId: LibraryId) => (paginationOpts: PageOpts) => ({
  libraryId,
  paginationOpts,
});

/**
 * Starts the lists the artist credits page shows, for its route's loader: the first page of
 * credits, and the corrections, which one page holds.
 */
export const preloadCreditLists = (platform: PlatformSdk, libraryId: LibraryId): void => {
  void preloadFirstPage(platform.music.credits.list, creditArgs(libraryId), CREDITS_PAGE);
  void preloadFirstPage(
    platform.music.credits.overrides,
    creditArgs(libraryId),
    MAX_CREDIT_OVERRIDES,
  );
};

/** The commands that change a library's corrections, as `platform.music.credits` holds them. */
export type CorrectionCommands = Pick<
  PlatformSdk["music"]["credits"],
  "setOverride" | "removeOverride"
>;

/** A change to one credit's correction: set it to a mode, or remove it. */
export type CorrectionChange =
  | { readonly kind: "set"; readonly name: string; readonly mode: CorrectionMode }
  | { readonly kind: "remove"; readonly name: string };

/**
 * The command that makes `change` in a library, and the toast after it succeeds. The server then
 * credits the songs and albums naming the credit anew, and the credits list follows.
 */
export const correctionCall = (
  commands: CorrectionCommands,
  libraryId: LibraryId,
  change: CorrectionChange,
): { readonly call: () => Promise<null>; readonly success: string } =>
  Match.value(change).pipe(
    Match.discriminatorsExhaustive("kind")({
      set: ({ name, mode }) => ({
        call: () => commands.setOverride({ libraryId, name, mode }),
        success: "Correction saved",
      }),
      remove: ({ name }) => ({
        call: () => commands.removeOverride({ libraryId, name }),
        success: "Correction removed",
      }),
    }),
  );

/** Each correction as the page names it. */
const MODE_LABELS: Readonly<Record<CorrectionMode, string>> = {
  together: "Kept together",
  split: "Split",
};

/** Artist names joined as English copy writes them: "Revol, Ozuna, and Cosculluela". */
const NAMES = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** Whether a credit stays one artist now, or splits into the artists it names. */
const splitLine = (credit: Credit): string =>
  staysWhole(credit.name, credit.artists)
    ? "One artist"
    : `Credits ${NAMES.format(credit.artists)}`;

/** A credit row's facts: how it splits now, how many songs and albums name it, its correction. */
export const creditFacts = (credit: Credit): string =>
  [
    splitLine(credit),
    `${credit.uses} ${credit.uses === 1 ? "song or album" : "songs and albums"}`,
    credit.override === null ? null : `Corrected: ${MODE_LABELS[credit.override].toLowerCase()}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

/** The credit the Correct dialog is open for, and the correction chosen in it so far. */
export interface Choosing {
  readonly credit: Credit;
  readonly mode: CorrectionMode | null;
}

/** The artist credits page of a music library: its credits, their corrections, and the limit. */
export function CreditsScreen({ libraryId }: { readonly libraryId: LibraryId }) {
  const platform = usePlatform();
  const state = libraryStateOf(usePlatformQuery(platform.core.libraries.get, { libraryId }));

  return (
    <CreditsView
      state={state}
      back={<LibrariesCrumb />}
      renderLibraryCrumb={(library) => <LibraryCrumb libraryId={libraryId} name={library.name} />}
      corrections={<Corrections libraryId={libraryId} />}
    />
  );
}

/** The artist credits page's breadcrumb back to its library. */
function LibraryCrumb({
  libraryId,
  name,
}: {
  readonly libraryId: LibraryId;
  readonly name: string;
}) {
  return (
    <Link
      to="/admin/libraries/$libraryId"
      params={{ libraryId }}
      className="font-sans text-label/label text-text-muted hover:text-text"
    >
      {name}
    </Link>
  );
}

/** The artist credits page while its library loads. */
export function CreditsSkeleton({ back }: { readonly back: ReactNode }) {
  return (
    <>
      <PageHeader title="Artist credits" crumbs={[back]} />
      <ListSkeleton label="artist credits" />
    </>
  );
}

/**
 * The artist credits page for each {@link LibraryState}. Only a manager of a music library sees
 * `corrections`; anyone else reads why there is nothing to correct.
 */
export function CreditsView({
  state,
  back,
  renderLibraryCrumb,
  corrections,
}: {
  readonly state: LibraryState;
  /** The breadcrumb back to the libraries list. */
  readonly back: ReactNode;
  /** The breadcrumb back to the library itself. */
  readonly renderLibraryCrumb: (library: LibraryDetail) => ReactNode;
  /** The credits and corrections a manager works on. */
  readonly corrections: ReactNode;
}) {
  const header = (library: LibraryDetail | null) => (
    <PageHeader
      title="Artist credits"
      crumbs={library === null ? [back] : [back, renderLibraryCrumb(library)]}
    />
  );

  return Match.value(state).pipe(
    Match.discriminatorsExhaustive("kind")({
      loading: () => <CreditsSkeleton back={back} />,
      missing: () => (
        <>
          {header(null)}
          <Muted>This library doesn't exist, or it isn't shared with you.</Muted>
        </>
      ),
      failed: ({ message, retry }) => (
        <>
          {header(null)}
          <Failed message={message} retry={retry} />
        </>
      ),
      ready: ({ library }) => (
        <>
          {header(library)}
          {library.kind !== "music" ? (
            <Muted>Only music libraries have artist credits.</Muted>
          ) : library.level === "manage" ? (
            corrections
          ) : (
            <Muted>Only a manager of this library can correct its artist credits.</Muted>
          )}
        </>
      ),
    }),
  );
}

/** A music library's credits and corrections, for a manager of it. */
function Corrections({ libraryId }: { readonly libraryId: LibraryId }) {
  const platform = usePlatform();
  const commands = platform.music.credits;
  const credits = usePages(commands.list, creditArgs(libraryId), CREDITS_PAGE);
  const corrections = useAllPages(commands.overrides, creditArgs(libraryId), MAX_CREDIT_OVERRIDES);
  const actions = useActions<string>();
  const [choosing, setChoosing] = useState<Choosing | null>(null);

  const change = async (next: CorrectionChange): Promise<void> => {
    const { call, success } = correctionCall(commands, libraryId, next);
    const done = await actions.run(next.name, call, success);

    if (done !== undefined && next.kind === "set") setChoosing(null);
  };

  return (
    <CorrectionsView
      credits={credits}
      corrections={corrections}
      running={actions.running}
      choosing={choosing}
      onChoose={setChoosing}
      onSave={(name, mode) => void change({ kind: "set", name, mode })}
      onRemove={(name) => void change({ kind: "remove", name })}
    />
  );
}

/**
 * A manager's view of a music library's credits: the corrections with Remove correction and how
 * many of the limit they use, then each credit naming several artists with Correct. At the limit a
 * credit without a correction cannot take one; one with a correction can still change it.
 */
export function CorrectionsView({
  credits,
  corrections,
  running,
  choosing,
  onChoose,
  onSave,
  onRemove,
}: {
  readonly credits: Paged<Credit>;
  readonly corrections: Paged<Correction>;
  /** The credit whose correction is saving, so every button waits. */
  readonly running: string | null;
  readonly choosing: Choosing | null;
  readonly onChoose: (choosing: Choosing | null) => void;
  readonly onSave: (name: string, mode: CorrectionMode) => void;
  readonly onRemove: (name: string) => void;
}) {
  const busy = running !== null;
  const limitId = useId();

  const count =
    corrections.status === "ready" && corrections.next.kind === "done"
      ? corrections.rows.length
      : null;

  const full = count !== null && count >= MAX_CREDIT_OVERRIDES;

  return (
    <>
      <Muted>
        Lar splits a credit such as “Mora & JHAYCO” into its artists once one of them has songs of
        their own. Keep a credit together or split it here; songs update after a moment.
      </Muted>
      <Section title="Corrections">
        {count === null ? null : <Muted>{`${count} of ${MAX_CREDIT_OVERRIDES} corrections`}</Muted>}
        <PagedList
          label="Corrections"
          list={corrections}
          empty="No corrections yet."
          rowKey={(correction) => correction.name}
          rowLabel={(correction) => correction.name}
        >
          {(correction) => (
            <ItemRow
              title={correction.name}
              facts={MODE_LABELS[correction.mode]}
              actions={
                <Button
                  variant="ghost"
                  size="row"
                  disabled={busy}
                  onClick={() => onRemove(correction.name)}
                >
                  Remove correction
                </Button>
              }
            />
          )}
        </PagedList>
      </Section>
      <Section title="Credits">
        {full ? (
          <Notice>
            <span id={limitId}>
              {`A library keeps at most ${MAX_CREDIT_OVERRIDES} corrections. Remove one to correct another credit.`}
            </span>
          </Notice>
        ) : null}
        <PagedList
          label="Credits"
          list={credits}
          empty="No credit in this library names several artists."
          rowKey={(credit) => credit.name}
          rowLabel={(credit) => credit.name}
        >
          {(credit) => {
            const blocked = full && credit.override === null;

            return (
              <ItemRow
                title={credit.name}
                facts={creditFacts(credit)}
                actions={
                  <Button
                    variant="raised"
                    size="row"
                    disabled={busy || blocked}
                    aria-describedby={blocked ? limitId : undefined}
                    onClick={() => onChoose({ credit, mode: credit.override })}
                  >
                    Correct
                  </Button>
                }
              />
            );
          }}
        </PagedList>
      </Section>
      <CorrectDialog choosing={choosing} busy={busy} onChoose={onChoose} onSave={onSave} />
    </>
  );
}

/** The dialog that sets one credit's correction. */
function CorrectDialog({
  choosing,
  busy,
  onChoose,
  onSave,
}: {
  readonly choosing: Choosing | null;
  readonly busy: boolean;
  readonly onChoose: (choosing: Choosing | null) => void;
  readonly onSave: (name: string, mode: CorrectionMode) => void;
}) {
  const changed =
    choosing !== null && choosing.mode !== null && choosing.mode !== choosing.credit.override;

  return (
    <Dialog open={choosing !== null} onOpenChange={(open) => (open ? undefined : onChoose(null))}>
      {choosing === null ? null : (
        <DialogContent title={`Correct ${choosing.credit.name}`} size="sm">
          <form
            onSubmit={(event) => {
              event.preventDefault();

              const { credit, mode } = choosing;

              if (mode !== null && mode !== credit.override) onSave(credit.name, mode);
            }}
          >
            <DialogBody>
              <Muted>{`Now: ${splitLine(choosing.credit)}.`}</Muted>
              <CorrectionChoices
                mode={choosing.mode}
                onChange={(mode) => onChoose({ ...choosing, mode })}
              />
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="dialog" />}>Cancel</DialogClose>
              <Button type="submit" size="dialog" disabled={busy || !changed}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** The corrections a credit can take, each with what it does. */
const CHOICES: ReadonlyArray<{
  readonly mode: CorrectionMode;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    mode: "together",
    label: "Keep together",
    hint: "One artist, also where it appears inside a longer credit.",
  },
  {
    mode: "split",
    label: "Split",
    hint: "Each name is an artist of its own, even with no songs of their own.",
  },
];

/**
 * Keep together or Split as radios, named by their labels and described by what each does;
 * `mode` is checked, and nothing is while the credit has no correction.
 */
export function CorrectionChoices({
  mode,
  onChange,
}: {
  readonly mode: CorrectionMode | null;
  readonly onChange: (mode: CorrectionMode) => void;
}) {
  const id = useId();

  return (
    <RadioGroup
      aria-label="Correction"
      value={mode}
      onValueChange={(value) => {
        const next = CHOICES.find((choice) => choice.mode === value);

        if (next !== undefined) onChange(next.mode);
      }}
      className="gap-4"
    >
      {CHOICES.map((choice) => (
        <label
          key={choice.mode}
          className="grid cursor-pointer grid-cols-[auto_1fr] items-start gap-x-3 gap-y-0.5"
        >
          <RadioItem
            value={choice.mode}
            aria-labelledby={`${id}-${choice.mode}`}
            aria-describedby={`${id}-${choice.mode}-hint`}
            className="mt-0.5"
          />
          <span id={`${id}-${choice.mode}`} className="font-sans text-label/label text-text">
            {choice.label}
          </span>
          <span
            id={`${id}-${choice.mode}-hint`}
            className="col-start-2 font-sans text-label/4 text-text-muted"
          >
            {choice.hint}
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}
