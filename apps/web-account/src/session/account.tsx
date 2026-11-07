import { PlatformProvider, usePlatform } from "@media/sdk/react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Predicate } from "effect";
import { createContext, use, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { deviceName } from "./device-name";
import { newSlot } from "./origin";
import type { Origin, OriginStore, SlotId } from "./origin";
import type { TileProof, UserId } from "./platform-types";

interface AccountContext {
  readonly store: OriginStore;
  readonly origin: Origin;
  /** The slot this tab's client runs on. */
  readonly slot: SlotId;
}

const Context = createContext<AccountContext | null>(null);

const useAccountContext = (): AccountContext => {
  const context = use(Context);

  if (context === null) throw new Error("useAccount must be used inside AccountProvider");

  return context;
};

/** This browser's account state, kept current across tabs. */
export const useOrigin = (): Origin => useAccountContext().origin;

/** The slot this tab's client runs on. */
export const useSlot = (): SlotId => useAccountContext().slot;

/** The store behind `useOrigin`, for the gate's repairs. */
export const useAccountStore = (): OriginStore => useAccountContext().store;

/**
 * Runs the platform client on the active slot, or on a fresh one while no one is active or while
 * the page signs someone new in. Switching the active person changes the slot, which opens a new client for
 * the tree, so a person's session never shares a client with another's.
 */
export function AccountProvider({
  store,
  url,
  freshSlot,
  children,
}: {
  readonly store: OriginStore;
  readonly url: string;
  /** The page signs someone new in: adding someone, an invite, or a reset link. */
  readonly freshSlot: boolean;
  readonly children: ReactNode;
}) {
  const origin = useSyncExternalStore(store.subscribe, store.read, store.read);
  const [staging, setStaging] = useState(() => ({ fresh: freshSlot, slot: newSlot() }));

  const taken = [...origin.people.values()].includes(staging.slot);

  // A slot promoted to a person is theirs. Entering a fresh-slot page again, or losing the active
  // person, needs a new one; the page that promotes the slot keeps it until it navigates away.
  const entering = freshSlot && !staging.fresh;
  const needsNew = taken && (entering || (!freshSlot && origin.active === null));

  if (freshSlot !== staging.fresh || needsNew) {
    setStaging({ fresh: freshSlot, slot: needsNew ? newSlot() : staging.slot });
  }

  const slot = freshSlot || origin.active === null ? staging.slot : origin.active;

  const context = useMemo(() => ({ store, origin, slot }), [store, origin, slot]);

  return (
    <Context value={context}>
      <PlatformProvider url={url} storage={store.sessions} storageKey={store.sessionKey(slot)}>
        {children}
      </PlatformProvider>
    </Context>
  );
}

const onPickerAfterSignIn = (pathname: string): boolean =>
  pathname === "/" || pathname === "/add" || pathname === "/invite" || pathname === "/reset";

/** A password sign-in, a first owner, an invite, or a reset link. */
type SignIn =
  | { readonly kind: "password"; readonly username: string; readonly password: string }
  | { readonly kind: "setUpOwner"; readonly username: string; readonly password: string }
  | {
      readonly kind: "invite";
      readonly code: string;
      readonly username: string;
      readonly password: string;
    }
  | { readonly kind: "reset"; readonly code: string; readonly password: string };

/** The sign-in worked, but this browser is a shared device, which opens tiles instead. */
export class SharedDeviceError extends Error {
  constructor() {
    super("This browser is a shared device. Choose your tile instead.");
    this.name = "SharedDeviceError";
  }
}

/** Who this browser acts as, and the ways to change it. */
export interface AccountActions {
  /** Signs in, registers this browser as a device, and makes the person active. */
  readonly signIn: (signIn: SignIn) => Promise<void>;
  /** Acts as a person this browser already holds a session for, with no password. */
  readonly switchTo: (userId: UserId) => void;
  /** Opens a person's tile on this shared device, with a proof for a locked tile. */
  readonly openTile: (userId: UserId, proof?: TileProof) => Promise<void>;
  /** Signs the active person out here; others on this browser stay. */
  readonly signOut: (userId: UserId) => Promise<void>;
}

/** The actions on this browser's people, for the current client. */
export const useAccountActions = (): AccountActions => {
  const { store, origin, slot } = useAccountContext();
  const platform = usePlatform();
  const navigate = useNavigate();
  const router = useRouter();

  /** Reads who signed in and registers this browser; a sign-in that cannot finish is ended. */
  const register = async (): Promise<UserId> => {
    try {
      const me = await platform.core.auth.sessions.current();

      if (me.kind !== "tile") {
        const device = store.read().device;

        const enrolled = await platform.core.devices.registry.enroll(
          device === null ? { name: deviceName() } : { name: deviceName(), device },
        );

        store.setDevice(enrolled.device);
      }

      return me.userId;
    } catch (cause) {
      await platform.session.signOut();

      if (Predicate.isTagged(cause, "Conflict")) throw new SharedDeviceError();

      throw cause;
    }
  };

  const establish = async (): Promise<void> => {
    const userId = await register();

    store.promote(slot, userId);

    // A page that asked for a sign-in, such as /device from a CLI's link, shows once it is done;
    // the picker, Add someone, an invite, and a reset link go on to the picker.
    if (onPickerAfterSignIn(router.state.location.pathname)) {
      await navigate({ to: "/", replace: true });
    }
  };

  return {
    signIn: async (signIn) => {
      const { session } = platform;

      switch (signIn.kind) {
        case "password":
          await session.signInWithPassword(signIn);
          break;
        case "setUpOwner":
          await session.setUpOwner(signIn);
          break;
        case "invite":
          await session.acceptInvite(signIn);
          break;
        case "reset":
          await session.resetPassword(signIn);
          break;
      }

      await establish();
    },
    switchTo: (userId) => {
      const held = origin.people.get(userId);

      if (held === undefined) {
        void navigate({ to: "/add" });

        return;
      }

      store.activate(held);
      void navigate({ to: "/home" });
    },
    openTile: async (userId, proof) => {
      const device = store.read().device;

      if (device === null) throw new SharedDeviceError();

      await platform.session.openTile(
        proof === undefined ? { device, userId } : { device, userId, proof },
      );
      store.promote(slot, userId);
      await navigate({ to: "/home" });
    },
    signOut: async (userId) => {
      try {
        await platform.session.signOut();
      } finally {
        store.forget(userId);
        await navigate({ to: "/" });
      }
    },
  };
};
