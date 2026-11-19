import type { PlatformSdk } from "@media/sdk/promise";
import { Redacted } from "effect";

import { guestExpiryDays } from "./guest-links";
import type { GuestLinkRow, GuestTarget } from "./guest-links";

type Links = PlatformSdk["core"]["guests"]["links"];

interface Snapshot {
  readonly expiry: string;
  readonly pending: boolean;
  readonly copied: boolean;
  readonly newLink: {
    readonly url: Redacted.Redacted;
    readonly linkId: GuestLinkRow["linkId"];
  } | null;
}

interface GuestLinkActions {
  readonly getSnapshot: () => Snapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly visible: (rows: ReadonlyArray<GuestLinkRow>) => Redacted.Redacted | null;
  readonly setExpiry: (expiry: string) => void;
  readonly create: () => Promise<void>;
  readonly revoke: (linkId: GuestLinkRow["linkId"]) => Promise<void>;
  readonly copy: (rows: ReadonlyArray<GuestLinkRow>) => Promise<void>;
}

/** Dialog-owned actions keep a single in-flight create and ignore answers after their owner leaves. */
export const guestLinkActions = (
  target: GuestTarget,
  links: Pick<Links, "create" | "revoke">,
  clipboard: (text: string) => Promise<void>,
  notify: { readonly copied: () => void; readonly failed: (cause: unknown) => void },
): GuestLinkActions => {
  let state: Snapshot = { expiry: "7", pending: false, copied: false, newLink: null };
  const listeners = new Set<() => void>();
  let lifetime = 0;

  const update = (patch: Partial<Snapshot>) => {
    state = { ...state, ...patch };

    for (const listener of listeners) listener();
  };

  const active = (started: number) => listeners.size > 0 && started === lifetime;

  return {
    getSnapshot: (): Snapshot => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);

        if (listeners.size === 0) lifetime += 1;
      };
    },
    visible: (rows: ReadonlyArray<GuestLinkRow>): Redacted.Redacted | null =>
      state.newLink !== null &&
      rows.some((row) => row.linkId === state.newLink?.linkId && row.state === "open")
        ? state.newLink.url
        : null,
    setExpiry: (expiry: string) => update({ expiry }),
    create: async () => {
      const days = guestExpiryDays(state.expiry);

      if (days === null || state.pending || state.newLink !== null || listeners.size === 0) return;
      const started = lifetime;
      update({ pending: true });

      try {
        const result = await links.create({ target, expiresInDays: days });

        if (active(started)) {
          update({
            newLink: { url: Redacted.make(result.url), linkId: result.linkId },
            copied: false,
          });
        }
      } catch (cause) {
        if (active(started)) notify.failed(cause);
      } finally {
        if (active(started)) update({ pending: false });
      }
    },
    revoke: async (linkId: GuestLinkRow["linkId"]) => {
      if (state.pending || listeners.size === 0) return;
      const started = lifetime;
      update({ pending: true });

      try {
        await links.revoke({ linkId });

        if (active(started) && state.newLink?.linkId === linkId) update({ newLink: null });
      } catch (cause) {
        if (active(started)) notify.failed(cause);
      } finally {
        if (active(started)) update({ pending: false });
      }
    },
    copy: async (rows: ReadonlyArray<GuestLinkRow>) => {
      const { newLink } = state;

      if (
        newLink === null ||
        !rows.some((row) => row.linkId === newLink.linkId && row.state === "open")
      )
        return;
      const started = lifetime;

      try {
        await clipboard(Redacted.value(newLink.url));

        if (active(started)) {
          update({ copied: true });
          notify.copied();
        }
      } catch (cause) {
        if (active(started)) notify.failed(cause);
      }
    },
  };
};
