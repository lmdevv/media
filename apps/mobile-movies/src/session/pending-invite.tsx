import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert } from "react-native";

import { sameServer } from "@/lib/invite-link";
import type { InviteLink } from "@/lib/invite-link";

import { useConnection } from "./connection";

/** The pending invite and the way to change it. */
export interface PendingInvite {
  /** The invite code for the connected server, or null. */
  readonly code: string | null;
  /** Keeps `link` to redeem on its server, or forgets the invite with null. */
  readonly setInvite: (link: InviteLink | null) => void;
}

const PendingInviteContext = createContext<PendingInvite | null>(null);

/** Holds the invite being redeemed for this launch. */
export function PendingInviteProvider({ children }: { readonly children: ReactNode }) {
  const { connection } = useConnection();
  const [invite, setInvite] = useState<InviteLink | null>(null);

  useEffect(() => {
    if (connection === null) setInvite(null);
  }, [connection]);

  const code =
    invite !== null && connection !== null && sameServer(connection.mediaUrl, invite.server)
      ? invite.code
      : null;

  const value = useMemo(() => ({ code, setInvite }), [code]);

  return <PendingInviteContext.Provider value={value}>{children}</PendingInviteContext.Provider>;
}

/**
 * The invite being redeemed.
 *
 * @throws When used outside `PendingInviteProvider`, a programming error.
 */
export const usePendingInvite = (): PendingInvite => {
  const invite = useContext(PendingInviteContext);

  if (invite === null)
    throw new Error("usePendingInvite must be used inside PendingInviteProvider");

  return invite;
};

/**
 * Drops the pending invite while someone is signed in: after joining, or when a link arrives for
 * the account already signed in, which says so instead of waiting for a later sign-out.
 */
export const useDropInviteWhenSignedIn = (signedIn: boolean): void => {
  const { code, setInvite } = usePendingInvite();
  const seen = useRef(code);

  useEffect(() => {
    const arrived = code !== null && code !== seen.current;

    seen.current = code;

    if (!signedIn || code === null) return;
    setInvite(null);

    if (arrived) Alert.alert("Already Signed In", "Sign out to accept this invite.");
  }, [code, signedIn, setInvite]);
};
