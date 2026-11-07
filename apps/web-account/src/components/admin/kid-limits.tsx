import { Button } from "@media/ui/components/button";
import { Checkbox } from "@media/ui/components/checkbox";
import { Switch } from "@media/ui/components/switch";
import { useId, useState } from "react";

import { usePlatform } from "@media/sdk/react";

import type { UserId } from "@/session/platform-types";

import { useActions } from "./action";
import type { Paged } from "./pages";
import { Muted, SelectField } from "./parts";
import type { Choice } from "./parts";
import type { Library, LibraryId, Restrictions } from "./types";

/** Limits that hide nothing, which the core stores as none. */
export const NO_LIMITS: Restrictions = {
  maxMovieAge: null,
  hideUnrated: false,
  hideExplicitMusic: false,
  libraries: null,
};

/** The rating each well-known age stands for, on the core's 0 to 21 scale (PG is 7). */
const RATINGS: ReadonlyMap<number, string> = new Map([
  [0, "G"],
  [7, "PG"],
  [10, "TV-PG"],
  [13, "PG-13"],
  [14, "TV-14"],
  [17, "R"],
  [18, "NC-17"],
]);

type AgeChoice = "none" | `${number}`;

const AGE_CHOICES: ReadonlyArray<Choice<AgeChoice>> = [
  { value: "none", label: "No limit" },
  ...Array.from({ length: 22 }, (_, age): Choice<AgeChoice> => {
    const rating = RATINGS.get(age);

    return { value: `${age}`, label: rating === undefined ? `${age}` : `${age} · ${rating}` };
  }),
];

type LibraryScope = "every" | "chosen";

const SCOPE_CHOICES: ReadonlyArray<Choice<LibraryScope>> = [
  { value: "every", label: "Every library shared with them" },
  { value: "chosen", label: "Only the libraries chosen below" },
];

const sameLimits = (left: Restrictions, right: Restrictions): boolean =>
  left.maxMovieAge === right.maxMovieAge &&
  left.hideUnrated === right.hideUnrated &&
  left.hideExplicitMusic === right.hideExplicitMusic &&
  (left.libraries === null || right.libraries === null
    ? left.libraries === right.libraries
    : left.libraries.length === right.libraries.length &&
      left.libraries.every((id) => right.libraries?.includes(id) === true));

/** The kid-limits form of one member, given what is saved now. */
export function KidLimits({
  userId,
  saved,
  libraries,
}: {
  readonly userId: UserId;
  readonly saved: Restrictions | null;
  readonly libraries: Paged<Library>;
}) {
  const platform = usePlatform();
  const actions = useActions<"save" | "lift">();
  const [draft, setDraft] = useState<Restrictions>(saved ?? NO_LIMITS);

  return (
    <KidLimitsView
      saved={saved}
      draft={draft}
      libraries={libraries}
      running={actions.running}
      onChange={setDraft}
      onSave={() =>
        void actions.run(
          "save",
          () => platform.core.restrictions.set({ userId, restrictions: draft }),
          "Limits saved",
        )
      }
      onLift={() =>
        void actions.run(
          "lift",
          () => platform.core.restrictions.set({ userId, restrictions: null }),
          "Limits lifted",
        )
      }
    />
  );
}

/** What the form edits, what is saved, and the libraries the admin can choose from. */
export interface KidLimitsViewProps {
  readonly saved: Restrictions | null;
  readonly draft: Restrictions;
  readonly libraries: Paged<Library>;
  readonly running: "save" | "lift" | null;
  readonly onChange: (draft: Restrictions) => void;
  readonly onSave: () => void;
  readonly onLift: () => void;
}

/** A member's limits: the highest movie age, unrated and explicit filters, and their libraries. */
export function KidLimitsView({
  saved,
  draft,
  libraries,
  running,
  onChange,
  onSave,
  onLift,
}: KidLimitsViewProps) {
  const unchanged = sameLimits(draft, saved ?? NO_LIMITS);
  const chosen = draft.libraries;

  return (
    <div className="flex flex-col gap-4">
      <SelectField
        label="Highest movie age"
        value={draft.maxMovieAge === null ? "none" : `${draft.maxMovieAge}`}
        options={AGE_CHOICES}
        onChange={(value) =>
          onChange({ ...draft, maxMovieAge: value === "none" ? null : Number(value) })
        }
        className="max-w-80"
      />
      <SwitchRow
        label="Hide unrated movies"
        checked={draft.hideUnrated}
        onChange={(hideUnrated) => onChange({ ...draft, hideUnrated })}
      />
      <SwitchRow
        label="Hide explicit music"
        checked={draft.hideExplicitMusic}
        onChange={(hideExplicitMusic) => onChange({ ...draft, hideExplicitMusic })}
      />
      <SelectField
        label="Libraries"
        value={chosen === null ? "every" : "chosen"}
        options={SCOPE_CHOICES}
        onChange={(scope) => onChange({ ...draft, libraries: scope === "every" ? null : [] })}
        className="max-w-80"
      />
      {chosen === null ? null : (
        <LibraryChoices
          libraries={libraries}
          chosen={chosen}
          onChange={(next) => onChange({ ...draft, libraries: next })}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="xs" disabled={unchanged || running !== null} onClick={onSave}>
          Save limits
        </Button>
        {saved === null ? null : (
          <Button variant="ghost" size="xs" disabled={running !== null} onClick={onLift}>
            Lift all limits
          </Button>
        )}
      </div>
    </div>
  );
}

function SwitchRow({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();

  return (
    <div className="flex max-w-80 items-center justify-between gap-4">
      <label htmlFor={id} className="font-sans text-label/label text-text">
        {label}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function LibraryChoices({
  libraries,
  chosen,
  onChange,
}: {
  readonly libraries: Paged<Library>;
  readonly chosen: ReadonlyArray<LibraryId>;
  readonly onChange: (chosen: Array<LibraryId>) => void;
}) {
  if (libraries.status === "loading") return <Muted>Loading libraries…</Muted>;

  if (libraries.status === "failed") return <Muted>{libraries.message}</Muted>;

  const visible = new Set(libraries.rows.map((library) => library.libraryId));

  const hidden =
    libraries.next.kind === "done" ? chosen.filter((id) => !visible.has(id)).length : 0;

  const { next } = libraries;

  return (
    <div className="flex flex-col gap-1">
      {libraries.rows.length === 0 && next.kind === "done" ? (
        <Muted>No library is shared with you.</Muted>
      ) : null}
      {libraries.rows.map((library) => (
        <label key={library.libraryId} className="flex h-10 cursor-pointer items-center gap-3">
          <Checkbox
            checked={chosen.includes(library.libraryId)}
            onCheckedChange={(on) =>
              onChange(
                on
                  ? [...chosen.filter((id) => id !== library.libraryId), library.libraryId]
                  : chosen.filter((id) => id !== library.libraryId),
              )
            }
          />
          <span className="font-sans text-label/label text-text">{library.name}</span>
        </label>
      ))}
      {next.kind === "more" ? (
        <div>
          <Button variant="raised" size="xs" onClick={next.load}>
            Load more
          </Button>
        </div>
      ) : null}
      {hidden === 0 ? null : (
        <Muted>
          {hidden === 1
            ? "Also 1 library that isn't shared with you."
            : `Also ${hidden} libraries that aren't shared with you.`}
        </Muted>
      )}
    </div>
  );
}
