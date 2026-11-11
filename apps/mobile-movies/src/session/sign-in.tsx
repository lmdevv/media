import * as SignIn from "@media/mobile-core/sign-in";
import type { PendingDeviceSignIn, PlatformInvite, PlatformPassword } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { useServer } from "./connection";
import { phoneFor } from "./phone";

interface Gate {
  /** True while a sign-in is between its session opening and its device enrolled. */
  readonly busy: boolean;
  readonly hold: <A>(work: () => Promise<A>) => Promise<A>;
}

const GateContext = createContext<Gate | null>(null);

/**
 * Holds whether a sign-in is under way. The platform client reports signed in as soon as the
 * session opens, before the app issued its grant and enrolled, so the screens wait for `busy` to
 * clear before they move on.
 */
export function SignInGate({ children }: { readonly children: ReactNode }) {
  const [running, setRunning] = useState(0);

  const hold = useCallback(async <A,>(work: () => Promise<A>): Promise<A> => {
    setRunning((count) => count + 1);

    try {
      return await work();
    } finally {
      setRunning((count) => count - 1);
    }
  }, []);

  const value = useMemo(() => ({ busy: running > 0, hold }), [running, hold]);

  return <GateContext.Provider value={value}>{children}</GateContext.Provider>;
}

const useGate = (): Gate => {
  const gate = useContext(GateContext);

  if (gate === null) throw new Error("useSignIn must be used inside SignInGate");

  return gate;
};

/** Whether a sign-in is between its session opening and its device enrolled. */
export const useSigningIn = (): boolean => useGate().busy;

/** The ways this app signs in to its server, each finished with the phone's grant and enrolling. */
export interface SignIns {
  /** Signs in with a password, which also issues the phone's grant (D64). */
  readonly password: (credentials: PlatformPassword) => Promise<void>;
  /** Creates the server's owner from the app and signs in. */
  readonly setUpOwner: (credentials: PlatformPassword) => Promise<void>;
  /** Creates an account from an invite and signs in. */
  readonly acceptInvite: (invite: PlatformInvite) => Promise<void>;
  /** Starts a sign-in another signed-in device approves. */
  readonly startDeviceSignIn: () => Promise<PendingDeviceSignIn>;
  /**
   * Signs in silently with the phone's grant when this app never had a session of its own (D48,
   * D59).
   */
  readonly onLaunch: () => Promise<SignIn.LaunchSignIn>;
}

/** The sign-ins for the connected server. */
export const useSignIn = (): SignIns => {
  const platform = usePlatform();
  const { mediaUrl } = useServer();
  const { hold } = useGate();

  return useMemo(() => {
    const phone = phoneFor(mediaUrl);

    return {
      password: (credentials) =>
        hold(() => SignIn.signInWithPassword(platform, phone, credentials)),
      setUpOwner: (credentials) => hold(() => SignIn.setUpOwner(platform, phone, credentials)),
      acceptInvite: (invite) => hold(() => SignIn.acceptInvite(platform, phone, invite)),
      startDeviceSignIn: async () => {
        const pending = await SignIn.startDeviceSignIn(platform, phone);

        return { ...pending, complete: () => hold(pending.complete) };
      },
      onLaunch: () => hold(() => SignIn.signInOnLaunch(platform, phone)),
    };
  }, [platform, mediaUrl, hold]);
};
