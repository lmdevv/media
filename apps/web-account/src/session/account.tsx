import { createPlatform, holdSignIn, readDevice } from "@media/sdk/promise";
import type { BrowserDevice, DeviceOrder, PlatformSdk } from "@media/sdk/promise";
import { PlatformProvider, usePlatform } from "@media/sdk/react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Match, Predicate } from "effect";
import { createContext, use, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import type { BrowserStore } from "./browser";
import { deviceName } from "./device-name";
import type { TileProof, UserId } from "./platform-types";

interface AccountContext {
  readonly store: BrowserStore;
  readonly url: string;
  readonly device: BrowserDevice | null;
}

const Context = createContext<AccountContext | null>(null);

const useAccountContext = (): AccountContext => {
  const context = use(Context);

  if (context === null) throw new Error("useAccount must be used inside AccountProvider");

  return context;
};

/** The device this browser keeps, current across tabs; null before its first sign-in. */
export const useDevice = (): BrowserDevice | null => useAccountContext().device;

/** Runs the platform client on the browser's one session, which every tab follows. */
export function AccountProvider({
  store,
  url,
  children,
}: {
  readonly store: BrowserStore;
  readonly url: string;
  readonly children: ReactNode;
}) {
  const device = useSyncExternalStore(store.subscribe, store.device, store.device);
  const context = useMemo(() => ({ store, url, device }), [store, url, device]);

  return (
    <Context value={context}>
      <PlatformProvider url={url} storage={store.sessions}>
        {children}
      </PlatformProvider>
    </Context>
  );
}

const returnsToStartAfterSignIn = (pathname: string): boolean =>
  pathname === "/" || pathname === "/invite" || pathname === "/reset";

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

/** The ways to change who this browser acts as. */
export interface AccountActions {
  /** Signs in, registers this browser as a device, and makes the person this browser's one. */
  readonly signIn: (signIn: SignIn) => Promise<void>;
  /** Opens a person's tile on this shared device, with a proof for a locked tile. */
  readonly openTile: (userId: UserId, proof?: TileProof) => Promise<void>;
  /** Signs this browser's person out; switching person is signing out, then in. */
  readonly signOut: () => Promise<void>;
}

const signInWith = (opener: PlatformSdk): ((signIn: SignIn) => Promise<void>) =>
  Match.type<SignIn>().pipe(
    Match.discriminatorsExhaustive("kind")({
      password: (password) => opener.session.signInWithPassword(password),
      setUpOwner: (owner) => opener.session.setUpOwner(owner),
      invite: (invite) => opener.session.acceptInvite(invite),
      reset: (reset) => opener.session.resetPassword(reset),
    }),
  );

/** The actions on this browser's session, for the current client. */
export const useAccountActions = (): AccountActions => {
  const { store, url } = useAccountContext();
  const platform = usePlatform();
  const navigate = useNavigate();
  const router = useRouter();

  const signInThenKeep = async (
    start: (opener: PlatformSdk, kept: BrowserDevice | null) => Promise<DeviceOrder>,
  ): Promise<void> => {
    const kept = await readDevice(store.sessions);
    const held = holdSignIn();
    const opener = createPlatform({ url, connection: "http", storage: held.storage });

    try {
      const order = await start(opener, kept);

      if (!(await held.keep(store.sessions, order))) {
        throw new Error("Someone else signed in here at the same moment.");
      }
    } catch (cause) {
      await opener.session.signOut().catch(() => undefined);

      throw cause;
    } finally {
      await opener.dispose();
    }
  };

  return {
    signIn: async (signIn) => {
      await signInThenKeep(async (opener, kept) => {
        await signInWith(opener)(signIn);

        const name = deviceName();

        const joined = await opener.core.devices.registry
          .enroll(kept === null ? { name } : { name, device: kept.code })
          .catch((cause: unknown) => {
            throw Predicate.isTagged(cause, "Conflict") ? new SharedDeviceError() : cause;
          });

        return {
          deviceId: joined.deviceId,
          code: joined.device,
          sequence: joined.joinSequence,
          basedOn: kept?.id ?? null,
        };
      });

      if (returnsToStartAfterSignIn(router.state.location.pathname)) {
        await navigate({ to: "/", replace: true });
      }
    },
    openTile: async (userId, proof) => {
      await signInThenKeep(async (opener, kept) => {
        if (kept === null) throw new SharedDeviceError();

        await opener.session.openTile(
          proof === undefined
            ? { device: kept.code, userId }
            : { device: kept.code, userId, proof },
        );

        const { device } = await opener.core.auth.sessions.current();

        if (device === null) throw new Error("The server's answer named no device. Try again.");

        return {
          deviceId: device.deviceId,
          code: kept.code,
          sequence: device.joinSequence,
          basedOn: kept.id,
        };
      });

      await navigate({ to: "/home" });
    },
    signOut: async () => {
      try {
        await platform.session.signOut();
      } finally {
        await navigate({ to: "/" });
      }
    },
  };
};
