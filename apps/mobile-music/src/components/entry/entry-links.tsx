import * as Linking from "expo-linking";
import { router, usePathname } from "expo-router";
import { createContext, use, useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert } from "react-native";

import { entryPath, linkIsFor, parseEntryLink } from "@/lib/entry-link";
import type { EntryLink } from "@/lib/entry-link";
import { describeConnectFailure, discoverServer } from "@media/mobile-core/server";
import type { ServerConnection } from "@media/mobile-core/server";
import { displayHost } from "@/lib/server";
import type { SettledPhase } from "@/lib/session-phase";
import { useConnection, useConnectionControls } from "@/session/connection";

/** A link waiting to open on its server's sign-in screens. */
interface HeldLink {
  readonly link: EntryLink;
}

/** The link waiting for its server, and the ways to set or drop it. */
interface PendingLink {
  readonly held: HeldLink | null;
  /** Keeps `link` to open once its server shows Sign in. */
  readonly hold: (link: EntryLink) => void;
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

const connectTo = async (
  server: string,
  connectedMeanwhile: () => boolean,
  connect: (connection: ServerConnection) => void,
): Promise<boolean> => {
  const result = await discoverServer(server);

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
    setHeld({ link });
  };

  const latest = useRef(connection);

  useEffect(() => {
    latest.current = connection;
  }, [connection]);

  const open = useEffectEvent(async (url: string | null) => {
    const opened = url === null ? null : parseEntryLink(url);

    if (opened === null) return;

    const current = latest.current;
    const server = opened.server;

    if (current !== null && linkIsFor(opened, current.mediaUrl)) {
      setLink(opened);

      return;
    }

    if (server === null) {
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
      `This link is for ${server}. You’re connected to ${displayHost(current.mediaUrl)}.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Switch server", onPress: () => void switchServer() },
      ],
    );
  });

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
} as const satisfies Record<EntryLink["kind"], string>;

/**
 * Opens the waiting link once the connected server shows its signed-out screens. Someone signed in is told why
 * nothing opened, and a server with nobody on it yet has no invites or resets to open.
 */
export function OpenEntryLink({ phase }: { readonly phase: SettledPhase["kind"] }) {
  const { held, drop } = usePendingLink();
  const { mediaUrl } = useConnection();
  const pathname = usePathname();

  useEffect(() => {
    if (held === null) return;
    const { link } = held;

    if (!linkIsFor(link, mediaUrl)) {
      drop();

      return;
    }

    switch (phase) {
      case "signedOut": {
        const path = entryPath(link);

        if (pathname === "/") return;

        drop();
        router.push(path);

        return;
      }

      case "ready":
      case "needsLibrary":
      case "scanning":
        drop();
        Alert.alert("Already signed in", SIGNED_IN[link.kind]);

        return;
      case "needsOwner":
      case "disconnected":
        drop();

        return;
      case "unreachable":
      case "offline":
        return;
    }
  }, [held, phase, mediaUrl, drop, pathname]);

  return null;
}
