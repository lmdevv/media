import type { PlatformSdk } from "@media/sdk/promise";
import { Button } from "@media/ui/components/button";
import { Switch } from "@media/ui/components/switch";
import { FieldError, TextField } from "@media/ui/components/text-field";
import { CheckIcon } from "lucide-react";
import { useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { PasswordField } from "@/components/auth-page";
import { Muted, Section, SelectField } from "@/components/admin/parts";
import type { Choice } from "@/components/admin/parts";
import { PASSWORD_RULE, passwordHint, passwordProblem } from "@/screens/entry/password";

import type { ActionStatus } from "./action";
import { UNLOCK_CODE, codeDigits, isUnlockCode } from "./unlock-code";

/** The person's settings: those that follow them, and theirs on this device (null on no device). */
export type Settings = Awaited<ReturnType<PlatformSdk["core"]["settings"]["get"]>>;

/** Some settings to change; each goes to the person or to this device as the core marks it. */
export type SettingsChange = Parameters<PlatformSdk["core"]["settings"]["set"]>[0];

type UserSettings = Settings["user"];

type DeviceSettings = NonNullable<Settings["device"]>;

/** Every setting's label; a setting the core adds fails to compile here until it has one. */
const LABELS = {
  subtitleLanguage: "Subtitles",
  audioLanguage: "Audio language",
  subtitleStyle: "Subtitle style",
  autoplay: "Autoplay",
  explicitFilter: "Hide explicit music",
  crossfade: "Crossfade",
  gapless: "Gapless playback",
  streamQuality: "Streaming quality",
  downloadQuality: "Download quality",
  volume: "Volume",
} as const satisfies { readonly [K in keyof UserSettings | keyof DeviceSettings]: string };

/** One line under a form: why it failed, or once it worked, `done` if given. */
function Outcome({ status, done }: { readonly status: ActionStatus; readonly done?: string }) {
  if (status.kind === "done" && done !== undefined) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-label/label text-text-muted">
        <CheckIcon className="size-3.5 text-success" strokeWidth={2} aria-hidden />
        {done}
      </p>
    );
  }

  if (status.kind === "failed") {
    return (
      <div role="alert">
        <FieldError className="pt-0">{status.message}</FieldError>
      </div>
    );
  }

  return null;
}

const FORM = "flex max-w-120 flex-col gap-4";

/**
 * A form's key, which changes each time `status` turns done: the form starts empty after each
 * success, and keeps what was typed while a later submit runs or once it fails.
 */
const useSuccessCount = (status: ActionStatus): number => {
  const done = status.kind === "done";
  const [seen, setSeen] = useState({ done, count: 0 });

  if (done === seen.done) return seen.count;

  const next = { done, count: done ? seen.count + 1 : seen.count };

  setSeen(next);

  return next.count;
};

/** The person's username. */
export function NameSection({
  username,
  status,
  onRename,
}: {
  readonly username: string;
  readonly status: ActionStatus;
  readonly onRename: (username: string) => void;
}) {
  const [draft, setDraft] = useState(username);
  const next = draft.trim();
  const unchanged = next === "" || next === username;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!unchanged) onRename(next);
  };

  return (
    <Section title="Username">
      <form className={FORM} onSubmit={submit}>
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          type="submit"
          variant="raised"
          size="sm"
          className="self-start"
          disabled={unchanged || status.kind === "pending"}
        >
          Save
        </Button>
        <Outcome status={status} done="Username saved." />
      </form>
    </Section>
  );
}

/** A password change, which signs out the person's other sessions. */
export function PasswordSection({
  status,
  onChange,
}: {
  readonly status: ActionStatus;
  readonly onChange: (change: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }) => void;
}) {
  const successes = useSuccessCount(status);

  return (
    <Section title="Password">
      <PasswordForm key={successes} status={status} onChange={onChange} />
    </Section>
  );
}

function PasswordForm({
  status,
  onChange,
}: {
  readonly status: ActionStatus;
  readonly onChange: (change: {
    readonly currentPassword: string;
    readonly newPassword: string;
  }) => void;
}) {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const problem = newPassword === "" ? null : passwordProblem(newPassword);
  const ready = currentPassword !== "" && newPassword !== "" && problem === null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (ready) onChange({ currentPassword, newPassword });
  };

  return (
    <form className={FORM} onSubmit={submit}>
      <PasswordField
        label="Current password"
        name="current-password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(event) => setCurrent(event.target.value)}
      />
      <PasswordField
        label={`New password, ${PASSWORD_RULE}`}
        name="new-password"
        autoComplete="new-password"
        value={newPassword}
        hint={passwordHint(newPassword)}
        error={problem ?? undefined}
        onChange={(event) => setNew(event.target.value)}
      />
      <Muted>Changing it signs you out everywhere else.</Muted>
      <Button
        type="submit"
        variant="raised"
        size="sm"
        className="self-start"
        disabled={!ready || status.kind === "pending"}
      >
        Change password
      </Button>
      <Outcome status={status} done="Password changed." />
    </form>
  );
}

/**
 * The unlock code. The core shows no one whether a code is set, so the section offers setting a
 * new one and turning it off.
 */
export function UnlockCodeSection({
  status,
  onSet,
}: {
  readonly status: ActionStatus;
  /** A new code, or null to turn it off. */
  readonly onSet: (code: string | null) => void;
}) {
  const [last, setLast] = useState<"set" | "off">("set");
  const successes = useSuccessCount(status);

  const send = (code: string | null): void => {
    setLast(code === null ? "off" : "set");
    onSet(code);
  };

  return (
    <Section title="Unlock code">
      <Muted>
        {`${UNLOCK_CODE.min} to ${UNLOCK_CODE.max} digits that open your tile on a shared device's lock screen. It never signs you in.`}
      </Muted>
      <CodeForm key={successes} status={status} onSet={send} />
      <Outcome status={status} done={last === "set" ? "Unlock code saved." : "Unlock code off."} />
    </Section>
  );
}

function CodeForm({
  status,
  onSet,
}: {
  readonly status: ActionStatus;
  readonly onSet: (code: string | null) => void;
}) {
  const [code, setCode] = useState("");
  const pending = status.kind === "pending";

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (isUnlockCode(code)) onSet(code);
  };

  return (
    <form className={FORM} onSubmit={submit}>
      <PasswordField
        label="New unlock code"
        name="unlock-code"
        inputMode="numeric"
        autoComplete="off"
        minLength={UNLOCK_CODE.min}
        maxLength={UNLOCK_CODE.max}
        value={code}
        onChange={(event) => setCode(codeDigits(event.target.value))}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="raised" size="sm" disabled={!isUnlockCode(code) || pending}>
          Set code
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => onSet(null)}
        >
          Turn off
        </Button>
      </div>
    </form>
  );
}

/**
 * Whether the person's tile shows on every shared device. A kid's is an admin's call. The core shows
 * no one their own choice, so the section offers both.
 */
export function SharedDevicesSection({
  kid,
  status,
  onList,
}: {
  readonly kid: boolean;
  readonly status: ActionStatus;
  readonly onList: (listed: boolean) => void;
}) {
  const [last, setLast] = useState(true);

  const send = (listed: boolean): void => {
    setLast(listed);
    onList(listed);
  };

  return (
    <Section title="Shared devices">
      {kid ? (
        <Muted>An admin decides whether you show on shared devices.</Muted>
      ) : (
        <>
          <Muted>Your tile on every shared device's picker, such as a family TV.</Muted>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="raised"
              size="sm"
              disabled={status.kind === "pending"}
              onClick={() => send(true)}
            >
              Show me
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={status.kind === "pending"}
              onClick={() => send(false)}
            >
              Take me off
            </Button>
          </div>
          <Outcome
            status={status}
            done={last ? "You're on shared devices." : "You're off shared devices."}
          />
        </>
      )}
    </Section>
  );
}

const LANGUAGES = [
  "ar",
  "da",
  "de",
  "en",
  "es",
  "fi",
  "fr",
  "he",
  "hi",
  "it",
  "ja",
  "ko",
  "nl",
  "no",
  "pl",
  "pt",
  "ru",
  "sv",
  "tr",
  "uk",
  "zh",
] as const;

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

/** The languages to offer, with `current` kept when the list lacks it; `""` means none. */
const languageChoices = (current: string | null, none: string): ReadonlyArray<Choice<string>> => [
  { value: "", label: none },
  ...[...new Set([...LANGUAGES, ...(current === null ? [] : [current])])]
    .map((code) => ({ value: code, label: languageNames.of(code) ?? code }))
    .toSorted((a, b) => a.label.localeCompare(b.label)),
];

const toLanguage = (value: string): string | null => (value === "" ? null : value);

const STYLE_CHOICES = {
  size: [
    { value: "small", label: "Small" },
    { value: "medium", label: "Medium" },
    { value: "large", label: "Large" },
  ],
  color: [
    { value: "white", label: "White" },
    { value: "yellow", label: "Yellow" },
  ],
  backdrop: [
    { value: "none", label: "None" },
    { value: "shadow", label: "Shadow" },
    { value: "box", label: "Box" },
  ],
} as const;

const STREAM_CHOICES: ReadonlyArray<Choice<DeviceSettings["streamQuality"]>> = [
  { value: "auto", label: "Automatic" },
  { value: "original", label: "Original" },
  { value: "high", label: "High, 1080p" },
  { value: "standard", label: "Standard, 720p" },
  { value: "low", label: "Low, 480p" },
];

const DOWNLOAD_CHOICES: ReadonlyArray<Choice<DeviceSettings["downloadQuality"]>> = [
  { value: "standard", label: "Standard" },
  { value: "high", label: "High" },
];

const CROSSFADE_MAX_SECONDS = 12;

const crossfadeChoices: ReadonlyArray<Choice<string>> = Array.from(
  { length: CROSSFADE_MAX_SECONDS + 1 },
  (_, seconds) => ({ value: String(seconds), label: seconds === 0 ? "Off" : `${seconds} s` }),
);

const VOLUME_STEPS = 10;

const percent = (volume: number): string => `${Math.round(volume * 100)}%`;

/** Volume in tenths, with the current level kept when the player set one between them. */
const volumeChoices = (current: number): ReadonlyArray<Choice<string>> =>
  [
    ...new Set([
      ...Array.from({ length: VOLUME_STEPS + 1 }, (_, step) => step / VOLUME_STEPS),
      current,
    ]),
  ]
    .toSorted((a, b) => a - b)
    .map((level) => ({ value: String(level), label: percent(level) }));

function SwitchRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();

  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <label htmlFor={id} className="font-sans text-body/body text-text">
        {label}
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function Group({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-sans text-body/body font-semibold text-text">{title}</h3>
        <Muted>{note}</Muted>
      </div>
      <div className="grid max-w-180 grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

/**
 * Playback settings in two groups: those that follow the person to every device, and theirs on
 * this device alone. Each change saves at once.
 */
export function PlaybackSection({
  settings,
  status,
  onChange,
}: {
  readonly settings: Settings;
  readonly status: ActionStatus;
  readonly onChange: (change: SettingsChange) => void;
}) {
  const { user, device } = settings;
  const style = user.subtitleStyle;
  const saving = status.kind === "pending";

  return (
    <Section title="Playback">
      <Group title="Everywhere" note="These follow you to every device.">
        <SelectField
          label={LABELS.subtitleLanguage}
          value={user.subtitleLanguage ?? ""}
          options={languageChoices(user.subtitleLanguage, "Off")}
          disabled={saving}
          onChange={(value) => onChange({ subtitleLanguage: toLanguage(value) })}
        />
        <SelectField
          label={LABELS.audioLanguage}
          value={user.audioLanguage ?? ""}
          options={languageChoices(user.audioLanguage, "The file's own")}
          disabled={saving}
          onChange={(value) => onChange({ audioLanguage: toLanguage(value) })}
        />
        <SelectField
          label={`${LABELS.subtitleStyle}: size`}
          value={style.size}
          options={STYLE_CHOICES.size}
          disabled={saving}
          onChange={(size) => onChange({ subtitleStyle: { ...style, size } })}
        />
        <SelectField
          label={`${LABELS.subtitleStyle}: color`}
          value={style.color}
          options={STYLE_CHOICES.color}
          disabled={saving}
          onChange={(color) => onChange({ subtitleStyle: { ...style, color } })}
        />
        <SelectField
          label={`${LABELS.subtitleStyle}: background`}
          value={style.backdrop}
          options={STYLE_CHOICES.backdrop}
          disabled={saving}
          onChange={(backdrop) => onChange({ subtitleStyle: { ...style, backdrop } })}
        />
        <SelectField
          label={LABELS.crossfade}
          value={String(user.crossfade)}
          options={crossfadeChoices}
          disabled={saving}
          onChange={(value) => onChange({ crossfade: Number(value) })}
        />
        <SwitchRow
          label={LABELS.autoplay}
          checked={user.autoplay}
          disabled={saving}
          onChange={(autoplay) => onChange({ autoplay })}
        />
        <SwitchRow
          label={LABELS.gapless}
          checked={user.gapless}
          disabled={saving}
          onChange={(gapless) => onChange({ gapless })}
        />
        <SwitchRow
          label={LABELS.explicitFilter}
          checked={user.explicitFilter}
          disabled={saving}
          onChange={(explicitFilter) => onChange({ explicitFilter })}
        />
      </Group>
      {device === null ? null : (
        <Group title="On this device" note="These stay on this browser.">
          <SelectField
            label={LABELS.streamQuality}
            value={device.streamQuality}
            options={STREAM_CHOICES}
            disabled={saving}
            onChange={(streamQuality) => onChange({ streamQuality })}
          />
          <SelectField
            label={LABELS.downloadQuality}
            value={device.downloadQuality}
            options={DOWNLOAD_CHOICES}
            disabled={saving}
            onChange={(downloadQuality) => onChange({ downloadQuality })}
          />
          <SelectField
            label={LABELS.volume}
            value={String(device.volume)}
            options={volumeChoices(device.volume)}
            disabled={saving}
            onChange={(value) => onChange({ volume: Number(value) })}
          />
        </Group>
      )}
      <Outcome status={status} />
    </Section>
  );
}
