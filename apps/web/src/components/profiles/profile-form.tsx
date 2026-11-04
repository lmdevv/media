import { AgeRating, KIDS_DEFAULT_MAX_AGE } from "@media/contracts/content-rating";
import type { Profile } from "@media/contracts/models/profiles";
import { useCommand } from "@media/sdk/react";
import { Avatar, EditableAvatar } from "@media/ui/components/avatar";
import { Button } from "@media/ui/components/button";
import { CodeInput } from "@media/ui/components/code-input";
import { Switch } from "@media/ui/components/switch";
import { FieldError, TextField } from "@media/ui/components/text-field";
import { cn } from "@media/ui/lib/utils";
import { Popover } from "@base-ui/react/popover";
import { useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { Schema } from "effect";
import { useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { AVATAR_KEYS, avatarHasLettering, avatarImage } from "@/lib/avatars";
import { describeFailure } from "@/lib/failure";
import { PIN_LENGTH } from "@/lib/pin";
import { useProfileChoice } from "@/session/profile-choice";

const age = Schema.decodeSync(AgeRating);

const KIDS_RATINGS: ReadonlyArray<{ readonly label: string; readonly age: AgeRating }> = [
  { label: "G", age: age(0) },
  { label: "PG", age: KIDS_DEFAULT_MAX_AGE },
  { label: "PG-13", age: age(13) },
];

const firstFreeAvatar = (takenAvatars: ReadonlyArray<string>): string =>
  AVATAR_KEYS.find((key) => key !== "kids" && !takenAvatars.includes(key)) ?? "red";

interface StartingValues {
  readonly name: string;
  readonly avatar: string;
  readonly kids: boolean;
  readonly maxAge: AgeRating;
  readonly hasPin: boolean;
}

const startingValues = (profile: Profile | undefined, freeAvatar: string): StartingValues => ({
  name: profile?.name ?? "",
  avatar: profile?.avatar ?? freeAvatar,
  kids: profile?.kids ?? false,
  maxAge: profile?.maxAgeRating ?? KIDS_DEFAULT_MAX_AGE,
  hasPin: profile?.hasPin ?? false,
});

/**
 * The profile editor. Without `profile` it creates one; with it, it edits that profile and offers
 * deletion when the account has another profile to keep.
 */
export function ProfileForm({
  profile,
  canDelete = false,
  takenAvatars = [],
}: {
  readonly profile?: Profile | undefined;
  readonly canDelete?: boolean;
  /** Avatars the account's other profiles use; a new profile starts on one that is free. */
  readonly takenAvatars?: ReadonlyArray<string>;
}) {
  const navigate = useNavigate();
  const createProfile = useCommand("profiles.create");
  const updateProfile = useCommand("profiles.update");
  const setPin = useCommand("profiles.setPin");
  const removeProfile = useCommand("profiles.remove");
  const { profileId: chosen, choose } = useProfileChoice();
  const freeAvatar = firstFreeAvatar(takenAvatars);
  const start = startingValues(profile, freeAvatar);
  const [name, setName] = useState(start.name);
  const [avatar, setAvatar] = useState(start.avatar);
  const avatarPicked = useRef(profile !== undefined);
  const [kids, setKids] = useState(start.kids);
  const [maxAge, setMaxAge] = useState<AgeRating>(start.maxAge);
  const [pinOn, setPinOn] = useState(start.hasPin);
  const [pin, setPinValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const nameId = useId();
  const pinChanged = pinOn !== start.hasPin || (pinOn && pin !== "");
  const displayName = name.trim() === "" ? "New profile" : name.trim();

  const back = (): void => {
    void navigate({ to: "/profiles" });
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (pinOn && !(profile?.hasPin ?? false) && pin.length !== PIN_LENGTH) {
      setError(`Enter a ${PIN_LENGTH}-digit PIN, or turn the PIN off.`);

      return;
    }

    setPending(true);
    setError(null);

    try {
      const saved =
        profile === undefined
          ? await createProfile({
              name: name.trim(),
              avatar,
              kids,
              maxAgeRating: kids ? maxAge : null,
            })
          : await updateProfile({
              profileId: profile.id,
              name: name.trim(),
              avatar,
              kids,
              maxAgeRating: kids ? maxAge : null,
            });

      if (pinChanged && (!pinOn || pin.length === PIN_LENGTH)) {
        await setPin({ profileId: saved.id, pin: pinOn ? pin : null });
      }

      back();
    } catch (cause) {
      setError(describeFailure(cause));
      setPending(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (profile === undefined) return;

    setPending(true);

    try {
      await removeProfile({ profileId: profile.id });

      if (chosen === profile.id) choose(null);

      back();
    } catch (cause) {
      setError(describeFailure(cause));
      setPending(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <form className="flex flex-col gap-12" onSubmit={(event) => void save(event)}>
      <h1 className="text-title/title font-bold tracking-display text-text">
        {profile === undefined ? "Add profile" : "Edit profile"}
      </h1>
      <div className="flex items-center gap-6">
        <AvatarPicker
          name={displayName}
          value={avatar}
          onChange={(key) => {
            setAvatar(key);
            avatarPicked.current = true;
          }}
        />
        <TextField
          id={nameId}
          label="Name"
          name="name"
          required
          maxLength={80}
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="grow basis-0"
        />
      </div>
      <div className="flex flex-col gap-9">
        <div className="flex flex-col gap-4">
          <SettingRow label="Kids profile">
            <Switch
              checked={kids}
              onCheckedChange={(on) => {
                setKids(on);

                if (!avatarPicked.current) setAvatar(on ? "kids" : freeAvatar);
              }}
              aria-label="Kids profile"
            />
          </SettingRow>
          {kids ? <MaxRatingChoice value={maxAge} onChange={setMaxAge} /> : null}
        </div>
        <div className="flex flex-col gap-4">
          <SettingRow label="Profile PIN">
            <Switch
              checked={pinOn}
              onCheckedChange={(on) => {
                setPinOn(on);
                setPinValue("");
              }}
              aria-label="Profile PIN"
            />
          </SettingRow>
          {pinOn ? (
            <CodeInput
              kind="pin"
              length={PIN_LENGTH}
              label={profile?.hasPin === true ? "New PIN" : "PIN"}
              value={pin}
              onValueChange={setPinValue}
            />
          ) : null}
        </div>
      </div>
      {error === null ? null : <FieldError className="-mt-6">{error}</FieldError>}
      {confirmingDelete && profile !== undefined ? (
        <ConfirmDelete
          name={profile.name}
          pending={pending}
          onCancel={() => setConfirmingDelete(false)}
          onDelete={() => void remove()}
        />
      ) : (
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={pending}
            className="bg-text px-6 text-bg hover:bg-text/85 active:bg-text/85"
          >
            Save
          </Button>
          <Button type="button" variant="subtle" onClick={back} className="bg-surface-raised">
            Cancel
          </Button>
          <span className="grow" />
          {profile !== undefined && canDelete ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="flex h-11 cursor-pointer items-center gap-2 text-label/caption font-medium text-text-muted hover:text-text"
            >
              <Trash2Icon className="size-4" strokeWidth={1.75} aria-hidden />
              Delete profile
            </button>
          ) : null}
        </div>
      )}
    </form>
  );
}

function MaxRatingChoice({
  value,
  onChange,
}: {
  readonly value: AgeRating;
  readonly onChange: (age: AgeRating) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Max rating" className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-label/caption font-medium text-text-muted">
        Max rating
      </span>
      {KIDS_RATINGS.map((rating) => {
        const selected = rating.age === value;

        return (
          <button
            key={rating.label}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(rating.age)}
            className={cn(
              "flex h-8 cursor-pointer items-center rounded-pill px-3.5 font-mono text-caption/caption transition-colors",
              selected ? "bg-text font-semibold text-bg" : "bg-text/8 text-text hover:bg-text/12",
            )}
          >
            {rating.label}
          </button>
        );
      })}
    </div>
  );
}

function ConfirmDelete({
  name,
  pending,
  onCancel,
  onDelete,
}: {
  readonly name: string;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="grow text-body/body text-text">Delete {name} with its history and list?</p>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="button" variant="destructive" disabled={pending} onClick={onDelete}>
        Delete profile
      </Button>
    </div>
  );
}

function SettingRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <span className="grow text-body/5 font-semibold text-text">{label}</span>
      {children}
    </div>
  );
}

function AvatarPicker({
  name,
  value,
  onChange,
}: {
  readonly name: string;
  readonly value: string;
  readonly onChange: (avatar: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <span ref={anchor} className="inline-flex shrink-0">
        <EditableAvatar
          name={name}
          image={avatarImage(value)}
          monogram={!avatarHasLettering(value)}
          onEdit={() => setOpen(true)}
        />
      </span>
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={8}
          className="z-50"
        >
          <Popover.Popup className="grid grid-cols-4 gap-3 rounded-card border border-text/8 bg-surface p-4 shadow-overlay outline-none">
            {AVATAR_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                aria-label={`Avatar ${key}`}
                aria-pressed={key === value}
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                className={cn(
                  "cursor-pointer rounded-poster transition-shadow",
                  key === value && "ring-2 ring-accent ring-offset-2 ring-offset-surface",
                )}
              >
                <Avatar
                  name={name}
                  image={avatarImage(key)}
                  monogram={!avatarHasLettering(key)}
                  className="size-14"
                  monogramClassName="p-1.5 text-heading/heading"
                />
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
