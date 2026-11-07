import { PlatformProvider, usePlatform } from "@media/sdk/react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Match, Predicate } from "effect";
import { createContext, use, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { deviceName } from "./device-name";
import { newSlot } from "./origin";
import type { Origin, OriginStore, SignedIn, SlotId } from "./origin";
import type { TileProof, UserId } from "./platform-types";
import { settleSignIn } from "./sign-in";

interface AccountContext {
  readonly store: OriginStore;
  readonly origin: Origin;
  /** The slot this tab's client runs on. */
  readonly slot: SlotId;
  /**
   * Keeps this tab's client on `slot` while a sign-in finishes there, or lets it follow the active
   * slot again with null, so another tab's sign-in cannot switch it away mid-sign-in.
   */
  readonly pin: (slot: SlotId | null) => void;
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
  const [pinned, pin] = useState<SlotId | null>(null);

  const taken = [...origin.people.values()].includes(staging.slot);

  // A slot promoted to a person is theirs. Entering a fresh-slot page again, or losing the active
  // person, needs a new one; the page that promotes the slot keeps it until it navigates away.
  const entering = freshSlot && !staging.fresh;
  const needsNew = taken && (entering || (!freshSlot && origin.active === null));

  if (freshSlot !== staging.fresh || needsNew) {
    setStaging({ fresh: freshSlot, slot: needsNew ? newSlot() : staging.slot });
  }

  const slot = pinned ?? (freshSlot || origin.active === null ? staging.slot : origin.active);

  const context = useMemo(() => ({ store, origin, slot, pin }), [store, origin, slot]);

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
  /** Signs this client's person out here; others on this browser stay. */
  readonly signOut: () => Promise<void>;
}

/** The actions on this browser's people, for the current client. */
export const useAccountActions = (): AccountActions => {
  const { store, origin, slot, pin } = useAccountContext();
  const platform = usePlatform();
  const navigate = useNavigate();
  const router = useRouter();

  /**
   * Registers this browser for the sign-in that stored `session`, with where the core joined it;
   * null when another sign-in took this slot before it could, which settles the slot itself. A
   * registration that cannot finish signs out this session alone.
   */
  const register = async (session: string): Promise<SignedIn | null> => {
    try {
      const me = await platform.core.auth.sessions.current();

      if (`${me.userId}|${me.sessionId}` !== session) return null;

      if (me.kind === "tile") return { userId: me.userId, session, joined: null };

      const { enroll } = platform.core.devices.registry;
      const device = store.read().device;

      const enrolled = await enroll(
        device === null ? { name: deviceName() } : { name: deviceName(), device },
      );

      // Another tab may have enrolled this browser at the same moment. The first device kept
      // wins, and this session moves onto it, so the picker lists everyone signed in here. The
      // device this tab enrolled is left for an admin to remove.
      const kept = await store.claimDevice(enrolled.device);

      const joined =
        kept === enrolled.device ? enrolled : await enroll({ name: deviceName(), device: kept });

      return {
        userId: me.userId,
        session,
        joined: { deviceId: joined.deviceId, sequence: joined.joinSequence },
      };
    } catch (cause) {
      await platform.session.signOutSession(session);

      if (Predicate.isTagged(cause, "Conflict")) throw new SharedDeviceError();

      throw cause;
    }
  };

  /** Settles the sign-in that stored `session`, then leaves the sign-in page. */
  const establish = async (session: string | null): Promise<void> => {
    if (session === null) throw new Error("The server's answer named no session. Sign in again.");

    // Of two sign-ins of one person, the core kept the one that joined the device later,
    // whichever tab promotes first; when that is another tab's, this session's slot goes.
    const signedIn = await register(session);

    if (signedIn !== null) await settleSignIn(store, slot, signedIn);

    // A page that asked for a sign-in, such as /device from a CLI's link, shows once it is done;
    // the picker, Add someone, an invite, and a reset link go on to the picker.
    if (onPickerAfterSignIn(router.state.location.pathname)) {
      await navigate({ to: "/", replace: true });
    }
  };

  /** Signs in as `signIn` says; the session it stored. */
  const signInWith: (signIn: SignIn) => Promise<string | null> = Match.type<SignIn>().pipe(
    Match.discriminatorsExhaustive("kind")({
      password: (password) => platform.session.signInWithPassword(password),
      setUpOwner: (owner) => platform.session.setUpOwner(owner),
      invite: (invite) => platform.session.acceptInvite(invite),
      reset: (reset) => platform.session.resetPassword(reset),
    }),
  );

  return {
    signIn: async (signIn) => {
      pin(slot);

      try {
        await establish(await signInWith(signIn));
      } finally {
        pin(null);
      }
    },
    switchTo: (userId) => {
      const held = origin.people.get(userId);

      if (held === undefined) {
        void navigate({ to: "/add" });

        return;
      }

      // From the picker the person goes home; from a page that asked for a sign-in, such as
      // /device from a CLI's link, they stay on it with its search.
      const stay = !onPickerAfterSignIn(router.state.location.pathname);

      void store.activate(held).then(() => (stay ? undefined : navigate({ to: "/home" })));
    },
    openTile: async (userId, proof) => {
      const device = store.read().device;

      if (device === null) throw new SharedDeviceError();

      const session = await platform.session.openTile(
        proof === undefined ? { device, userId } : { device, userId, proof },
      );

      if (session !== null) await settleSignIn(store, slot, { userId, session, joined: null });
      await navigate({ to: "/home" });
    },
    signOut: async () => {
      // Signs out the session this client holds and forgets its slot, both by that session's
      // name: another tab may sign the person in on a new slot, or open a tile in this slot,
      // meanwhile, and that session stays. Signing out returns once the store holds the
      // revocation; the server is told in the background.
      const signingOut = slot;
      const session = await platform.session.currentSession();

      try {
        if (session !== null) await platform.session.signOutSession(session);
      } finally {
        await store.forget(signingOut, session);
        await navigate({ to: "/" });
      }
    },
  };
};
