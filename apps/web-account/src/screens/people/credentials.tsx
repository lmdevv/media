import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";
import { Button } from "@media/ui/components/button";
import { Checkbox } from "@media/ui/components/checkbox";
import { PageHeader } from "@media/ui/components/page-header";
import { TextField } from "@media/ui/components/text-field";
import { useAllPages, usePages } from "@media/ui/lib/pages";
import type { Paged } from "@media/ui/lib/pages";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { useActions } from "@/components/admin/action";
import {
  CopyField,
  ItemRow,
  Muted,
  Notice,
  PagedList,
  Section,
  SelectField,
  formatTime,
} from "@/components/admin/parts";
import type { Choice } from "@/components/admin/parts";
import { useMe } from "@/session/me";

type Result<Method> = Method extends (...args: never) => Promise<infer A> ? A : never;

type RowOf<Method> =
  Result<Method> extends { readonly page: ReadonlyArray<infer Row> } ? Row : never;

type Auth = PlatformSdk["core"]["auth"];

/** One of the person's signed-in browsers, apps, or devices, as the core lists it. */
export type SessionRow = RowOf<Auth["sessions"]["list"]>;

/** One of the person's API keys, without its secret. */
export type KeyRow = RowOf<Auth["apiKeys"]["list"]>;

/** A scope a key can hold. */
export type KeyScope = KeyRow["scopes"][number];

/** A key just made, with its secret, which shows only this once. */
export type CreatedKey = Result<Auth["apiKeys"]["create"]>;

/** What Create key sends. */
export type NewKey = Parameters<Auth["apiKeys"]["create"]>[0];

const KIND_LABELS: Readonly<Record<SessionRow["kind"], string>> = {
  password: "Password",
  apiKey: "API key",
  grant: "App on a phone",
  deviceCode: "Device",
  tile: "Shared device",
};

/**
 * What a session is called: the name its device, key, or device sign-in gave, `This browser` for
 * this one, or `Password sign-in` for a browser or app that signed in on no device.
 */
export const sessionName = (session: SessionRow): string => {
  if (session.name !== null) return session.name;

  return session.current ? "This browser" : "Password sign-in";
};

/** Every scope's label, in the order Create key lists them. */
const SCOPE_LABELS: Readonly<Record<KeyScope, string>> = {
  "movies:read": "Browse movies",
  "movies:play": "Play movies",
  "movies:edit": "Edit movies",
  "music:read": "Browse music",
  "music:play": "Play music",
  "music:edit": "Edit music",
  account: "Your account",
  admin: "Admin",
};

const SCOPE_ORDER = Object.keys(SCOPE_LABELS);

const scopeRank = (scope: KeyScope): number => SCOPE_ORDER.indexOf(scope);

/** A key's scopes as Create key lists them, joined: `Browse movies, Play movies`. */
export const scopeLabels = (scopes: ReadonlyArray<KeyScope>): string =>
  scopes.length === 0
    ? "No scopes"
    : scopes
        .toSorted((left, right) => scopeRank(left) - scopeRank(right))
        .map((scope) => SCOPE_LABELS[scope])
        .join(", ");

/** A session's facts: how it signed in, its scopes, when, and when it ends unless used again. */
export const sessionFacts = (session: SessionRow): string =>
  [
    KIND_LABELS[session.kind],
    scopeLabels(session.scopes),
    `Signed in ${formatTime(session.signedInAt)}`,
    `Expires ${formatTime(session.expiresAt)}`,
  ].join(" · ");

/** What signing a session out does, as old movies said it: a key signs in again on its next use. */
export const signOutNote = (session: SessionRow): string =>
  session.kind === "apiKey"
    ? "The key signs in again the next time it is used. Revoke the key to stop it."
    : "It has to sign in again to keep watching.";

/** The start of a key as its secret begins, `mk_ab12cd34…`, which never shows the secret. */
export const keyPrefix = (key: Pick<KeyRow, "keyId">): string => `mk_${key.keyId.slice(0, 8)}…`;

/** When a key last signed in: `Last used …`, `Never used`, or `Expired` once it ran out. */
export const lastUsedLabel = (key: KeyRow, now: number): string => {
  if (key.expiresAt !== null && key.expiresAt <= now) return "Expired";

  return key.lastUsedAt === null ? "Never used" : `Last used ${formatTime(key.lastUsedAt)}`;
};

/** A key's facts, the ones a narrow row keeps first: last use, scopes, creation, and prefix. */
export const keyFacts = (key: KeyRow, now: number): string =>
  [
    lastUsedLabel(key, now),
    scopeLabels(key.scopes),
    `Created ${formatTime(key.createdAt)}`,
    keyPrefix(key),
  ].join(" · ");

/** Devices: the person's signed-in browsers, apps, and devices, each signed out from here. */
export function DevicesScreen() {
  const platform = usePlatform();

  // Every page: API keys' sessions are read and left out, so a page can come back empty.
  const sessions = useAllPages(platform.core.auth.sessions.list, (paginationOpts) => ({
    paginationOpts,
  }));

  const actions = useActions<"end">();
  const [ending, setEnding] = useState<SessionRow["sessionId"] | null>(null);

  return (
    <DevicesView
      sessions={sessions}
      ending={ending}
      running={actions.running !== null}
      onAsk={setEnding}
      onEnd={(session) => {
        void (async () => {
          const ended = await actions.run(
            "end",
            () => platform.core.auth.sessions.end({ sessionId: session.sessionId }),
            `Signed out ${sessionName(session)}`,
          );

          if (ended !== undefined) setEnding(null);
        })();
      }}
    />
  );
}

/** The session list; the one being signed out asks first. */
export function DevicesView({
  sessions,
  ending,
  running,
  onAsk,
  onEnd,
}: {
  readonly sessions: Paged<SessionRow>;
  readonly ending: SessionRow["sessionId"] | null;
  readonly running: boolean;
  readonly onAsk: (sessionId: SessionRow["sessionId"] | null) => void;
  readonly onEnd: (session: SessionRow) => void;
}) {
  return (
    <>
      <PageHeader title="Devices" />
      <PagedList
        label="Signed-in devices"
        list={sessions}
        empty="Nothing is signed in."
        rowKey={(session) => session.sessionId}
      >
        {(session) => (
          <ItemRow
            title={sessionName(session)}
            facts={sessionFacts(session)}
            actions={
              session.current ? (
                <Muted>Current</Muted>
              ) : ending === session.sessionId ? null : (
                <Button
                  variant="ghost"
                  size="row"
                  disabled={running}
                  aria-label={`Sign out ${sessionName(session)}`}
                  onClick={() => onAsk(session.sessionId)}
                >
                  Sign out
                </Button>
              )
            }
          >
            {ending === session.sessionId ? (
              <Notice
                action={
                  <div className="flex gap-2">
                    <Button variant="ghost" size="xs" onClick={() => onAsk(null)}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="xs"
                      disabled={running}
                      onClick={() => onEnd(session)}
                    >
                      Sign out
                    </Button>
                  </div>
                }
              >
                {signOutNote(session)}
              </Notice>
            ) : null}
          </ItemRow>
        )}
      </PagedList>
    </>
  );
}

const EXPIRY_CHOICES: ReadonlyArray<Choice<"30" | "90" | "365" | "never">> = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];

type Expiry = (typeof EXPIRY_CHOICES)[number]["value"];

/** What a new key holds until the person changes it, as old movies started it: browse and play. */
const DEFAULT_KEY_SCOPES: ReadonlyArray<KeyScope> = ["movies:read", "movies:play"];

const isKeyScope = (scope: string): scope is KeyScope =>
  SCOPE_ORDER.some((known) => known === scope);

/** API keys: the person's keys without their secrets, Create key, and revoke. */
export function ApiKeysScreen() {
  const platform = usePlatform();
  const me = useMe();
  const keys = usePages(platform.core.auth.apiKeys.list, (paginationOpts) => ({ paginationOpts }));
  const actions = useActions<"create" | "revoke">();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [revoking, setRevoking] = useState<KeyRow["keyId"] | null>(null);
  const [now] = useState(Date.now);

  return (
    <ApiKeysView
      keys={keys}
      grantable={me.scopes.filter(isKeyScope)}
      now={now}
      creating={creating}
      created={created}
      revoking={revoking}
      running={actions.running}
      onCreating={setCreating}
      onCreate={(key) => {
        void (async () => {
          const made = await actions.run("create", () => platform.core.auth.apiKeys.create(key));

          if (made === undefined) return;

          setCreating(false);
          setCreated(made);
        })();
      }}
      onDone={() => setCreated(null)}
      onAskRevoke={setRevoking}
      onRevoke={(key) => {
        void (async () => {
          const revoked = await actions.run(
            "revoke",
            () => platform.core.auth.apiKeys.revoke({ keyId: key.keyId }),
            `Revoked ${key.name}`,
          );

          if (revoked !== undefined) setRevoking(null);
        })();
      }}
    />
  );
}

/** The key list, Create key's form, and the secret of a key just made, shown once. */
export function ApiKeysView({
  keys,
  grantable,
  now,
  creating,
  created,
  revoking,
  running,
  onCreating,
  onCreate,
  onDone,
  onAskRevoke,
  onRevoke,
}: {
  readonly keys: Paged<KeyRow>;
  /** The scopes this session holds, the only ones a new key may hold. */
  readonly grantable: ReadonlyArray<KeyScope>;
  readonly now: number;
  readonly creating: boolean;
  readonly created: CreatedKey | null;
  readonly revoking: KeyRow["keyId"] | null;
  readonly running: "create" | "revoke" | null;
  readonly onCreating: (open: boolean) => void;
  readonly onCreate: (key: NewKey) => void;
  readonly onDone: () => void;
  readonly onAskRevoke: (keyId: KeyRow["keyId"] | null) => void;
  readonly onRevoke: (key: KeyRow) => void;
}) {
  return (
    <>
      <PageHeader
        title="API keys"
        actions={
          creating ? null : (
            <Button size="sm" onClick={() => onCreating(true)}>
              <PlusIcon strokeWidth={2} aria-hidden />
              Create key
            </Button>
          )
        }
      />
      {created === null ? null : (
        <Section title="Key created">
          <div className="flex max-w-180 flex-col gap-2">
            <span className="font-sans text-label/label font-medium text-text-muted">
              Your new key
            </span>
            <CopyField value={created.key} label="Your new key" />
            <Muted>
              {created.expiresAt === null
                ? "It never expires. It shows only this once."
                : `Works until ${formatTime(created.expiresAt)}. It shows only this once.`}
            </Muted>
            <div>
              <Button variant="ghost" size="xs" onClick={onDone}>
                Done
              </Button>
            </div>
          </div>
        </Section>
      )}
      {creating ? (
        <CreateKeyForm
          grantable={grantable}
          pending={running === "create"}
          onCancel={() => onCreating(false)}
          onCreate={onCreate}
        />
      ) : null}
      <PagedList label="API keys" list={keys} empty="No API keys." rowKey={(key) => key.keyId}>
        {(key) => (
          <ItemRow
            title={key.name}
            facts={keyFacts(key, now)}
            actions={
              revoking === key.keyId ? null : (
                <Button
                  variant="ghost"
                  size="row"
                  disabled={running !== null}
                  aria-label={`Revoke ${key.name}`}
                  onClick={() => onAskRevoke(key.keyId)}
                >
                  Revoke
                </Button>
              )
            }
          >
            {revoking === key.keyId ? (
              <Notice
                action={
                  <div className="flex gap-2">
                    <Button variant="ghost" size="xs" onClick={() => onAskRevoke(null)}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="xs"
                      disabled={running !== null}
                      onClick={() => onRevoke(key)}
                    >
                      Revoke
                    </Button>
                  </div>
                }
              >
                {`Anything using ${key.name} stops working and is signed out.`}
              </Notice>
            ) : null}
          </ItemRow>
        )}
      </PagedList>
    </>
  );
}

function CreateKeyForm({
  grantable,
  pending,
  onCancel,
  onCreate,
}: {
  readonly grantable: ReadonlyArray<KeyScope>;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onCreate: (key: NewKey) => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlyArray<KeyScope>>(DEFAULT_KEY_SCOPES);
  const [expiry, setExpiry] = useState<Expiry>("90");
  const offered = SCOPE_ORDER.filter(isKeyScope).filter((scope) => grantable.includes(scope));
  const chosen = scopes.filter((scope) => offered.includes(scope));
  const ready = name.trim() !== "" && chosen.length > 0 && !pending;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!ready) return;

    const base = { name: name.trim(), scopes: chosen };

    onCreate(expiry === "never" ? base : { ...base, expiresInDays: Number(expiry) });
  };

  return (
    <Section title="Create key">
      <form className="flex max-w-120 flex-col gap-4" onSubmit={submit}>
        <TextField
          label="Name"
          name="key-name"
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <fieldset className="flex flex-col">
          <legend className="pb-1 font-sans text-label/label font-medium text-text-muted">
            Scopes
          </legend>
          {offered.map((scope) => (
            <label key={scope} className="flex h-10 cursor-pointer items-center gap-3">
              <Checkbox
                checked={scopes.includes(scope)}
                onCheckedChange={(on) =>
                  setScopes(
                    on
                      ? [...scopes.filter((each) => each !== scope), scope]
                      : scopes.filter((each) => each !== scope),
                  )
                }
              />
              <span className="font-sans text-label/label text-text">{SCOPE_LABELS[scope]}</span>
            </label>
          ))}
        </fieldset>
        <SelectField
          label="Expires after"
          value={expiry}
          options={EXPIRY_CHOICES}
          onChange={setExpiry}
        />
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!ready}>
            Create key
          </Button>
        </div>
      </form>
    </Section>
  );
}
