/**
 * Opens invite (E08), password reset (E09), and Jam (D05, D07) links, from Messages, Mail,
 * Safari, or pasted into Connect. A link that names a server connects to it first when the app
 * has none; a link for another server asks before switching. The link then waits until its server
 * shows Sign in, and opens over it, so Back from the invite or reset returns to Sign in. A Jam
 * link opens in the app when someone is signed in, and can also wait for them to sign in.
 */
import * as Linking from "expo-linking";
import { router, usePathname } from "expo-router";
import { createContext, use, useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert } from "react-native";

import { entryPath, linkIsFor, parseEntryLink } from "@/lib/entry-link";
import type { EntryLink } from "@/lib/entry-link";
import { describeConnectFailure, discoverServer, displayHost } from "@/lib/server";
import type { ServerConnection } from "@/lib/server";
import type { SettledPhase } from "@/lib/session-phase";
import { useConnection, useConnectionControls } from "@/session/connection";

/**
 * When a held link opens: on its server's sign-in screens, or once the person has signed in. A Jam
 * link waits for sign-in when they chose to sign in to join (`invite`) or just made a guest account
 * from it, which joins the Jam on this iPhone (`join`).
 */
type HeldLink =
  | { readonly link: EntryLink; readonly after: "connect" }
  | { readonly link: EntryLink; readonly after: "signIn"; readonly opens: "invite" | "join" };

/** The link waiting for its server, and the ways to set or drop it. */
interface PendingLink {
  readonly held: HeldLink | null;
  /** Keeps `link` to open once its server shows Sign in. */
  readonly hold: (link: EntryLink) => void;
  /** Keeps a Jam link to open once the person signs in. */
  readonly holdForSignIn: (link: EntryLink, opens: "invite" | "join") => void;
  readonly drop: () => void;
}

const PendingLinkContext = createContext<PendingLink | null>(null);

const usePendingLink = (): PendingLink => {
  const pending = use(PendingLinkContext);

  if (pending === null) throw new Error("usePendingLink needs EntryLinksProvider above it");

  return pending;
};

/**
 * Keeps a link to open once its server shows Sign in, for Connect when the typed address is a
 * pasted invite or reset link.
 */
export const useHoldEntryLink = (): ((link: EntryLink) => void) => usePendingLink().hold;

/**
 * Keeps a Jam link to open once the person signs in: to its invite (`invite`), or to join it on this
 * iPhone after a guest sign-up put them in it (`join`). `drop` forgets it, as when sign-up fails.
 */
export const useHoldJamForSignIn = (): Pick<PendingLink, "holdForSignIn" | "drop"> => {
  const { holdForSignIn, drop } = usePendingLink();

  return { holdForSignIn, drop };
};

/** Finds the link's server and connects to it, or says why it can't. */
const connectTo = async (
  server: string,
  connectedMeanwhile: () => boolean,
  connect: (connection: ServerConnection) => void,
): Promise<boolean> => {
  const result = await discoverServer(server, fetch);

  if (connectedMeanwhile()) return false;

  if (!result.ok) {
    Alert.alert("Can’t open this link", describeConnectFailure(result.failure));

    return false;
  }

  connect(result.connection);

  return true;
};

/** Listens for entry links for the whole app, connected or not. */
export function EntryLinksProvider({ children }: { readonly children: ReactNode }) {
  const { connection, connect } = useConnectionControls();
  const [held, setHeld] = useState<HeldLink | null>(null);

  const setLink = (link: EntryLink) => {
    setHeld({ link, after: "connect" });
  };

  // Discovery takes a moment; whoever connects meanwhile wins over the link.
  const latest = useRef(connection);

  useEffect(() => {
    latest.current = connection;
  }, [connection]);

  const open = useEffectEvent(async (url: string | null) => {
    const opened = url === null ? null : parseEntryLink(url);

    if (opened === null) return;

    const current = latest.current;
    const server = opened.server;

    if (current !== null && linkIsFor(opened, current.origin)) {
      setLink(opened);

      return;
    }

    if (server === null) {
      // No server yet and the link names none: it opens on whichever server Connect finds.
      setLink(opened);
      router.push("/connect");

      return;
    }

    if (current === null) {
      if (await connectTo(server, () => latest.current !== null, connect)) setLink(opened);

      return;
    }

    const switchServer = async () => {
      if (await connectTo(server, () => latest.current !== current, connect)) setLink(opened);
    };

    Alert.alert(
      "Link for another server",
      `This link is for ${server}. You’re connected to ${displayHost(current.origin)}.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Switch server", onPress: () => void switchServer() },
      ],
    );
  });

  // Every opening counts, even of the same link twice, so this listens rather than reading the
  // latest URL.
  useEffect(() => {
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener("url", ({ url }) => void open(url));

    return () => subscription.remove();
  }, []);

  return (
    <PendingLinkContext
      value={{
        held,
        hold: setLink,
        holdForSignIn: (link, opens) => {
          setHeld({ link, after: "signIn", opens });
        },
        drop: () => {
          setHeld(null);
        },
      }}
    >
      {children}
    </PendingLinkContext>
  );
}

const SIGNED_IN = {
  invite: "You’re already signed in here, so this invite isn’t needed.",
  reset: "Sign out first, then open the reset link again.",
  jam: "Finish setting up your server first, then open the Jam link again.",
} as const satisfies Record<EntryLink["kind"], string>;

/** Opens a held link in the signed-in app, or says why there is nothing to open. */
const openSignedIn = (held: HeldLink): void => {
  const path = entryPath(held.link, true);

  if (path === null) {
    Alert.alert("Already signed in", SIGNED_IN[held.link.kind]);

    return;
  }

  router.push(held.after === "signIn" && held.opens === "join" ? `${path}?join=1` : path);
};

/**
 * Opens the waiting link once the connected server shows its signed-out screens. Someone signed in is told why
 * nothing opened, and a server with nobody on it yet has no invites or resets to open.
 */
export function OpenEntryLink({ phase }: { readonly phase: SettledPhase["kind"] }) {
  const { held, drop } = usePendingLink();
  const { origin } = useConnection();
  const pathname = usePathname();

  useEffect(() => {
    if (held === null) return;
    const { link } = held;

    if (!linkIsFor(link, origin)) {
      drop();

      return;
    }

    switch (phase) {
      case "signedOut": {
        // A stack that just mounted is still at "/" until it moves to Sign in, which would
        // replace a link opened before then.
        const path = entryPath(link, false);

        if (pathname === "/" || held.after === "signIn" || path === null) return;

        drop();
        router.push(path);

        return;
      }

      case "ready":
        // Right after signing in, the screen on show is still the one signed out until the
        // stack moves to Home; the link opens over Home.
        if (held.after === "signIn" && pathname !== "/") return;

        drop();
        openSignedIn(held);

        return;
      case "needsLibrary":
      case "scanning":
        drop();
        Alert.alert("Already signed in", SIGNED_IN[link.kind]);

        return;
      case "needsOwner":
      case "suspended":
      case "disconnected":
        drop();

        return;
      case "unreachable":
        return;
    }
  }, [held, phase, origin, drop, pathname]);

  return null;
}
