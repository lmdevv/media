import * as Linking from "expo-linking";
import { useEffect, useEffectEvent, useRef } from "react";
import { Alert } from "react-native";

import { describeConnectFailure, discoverServer } from "@media/mobile-core/server";
import type { ServerConnection } from "@media/mobile-core/server";
import { parseInviteLink, sameServer } from "@/lib/invite-link";
import { displayHost } from "@/lib/local-network";

import { useConnection } from "./connection";
import { usePendingInvite } from "./pending-invite";

/** Handles invite links that launch the app or arrive while it runs. Renders nothing. */
export function InviteLinks() {
  const { connection, connect } = useConnection();
  const { setInvite } = usePendingInvite();
  const latest = useRef<ServerConnection | null>(connection);

  useEffect(() => {
    latest.current = connection;
  }, [connection]);

  const connectedMeanwhile = (): boolean => latest.current !== null;

  const open = useEffectEvent(async (url: string | null) => {
    const link = url === null ? null : parseInviteLink(url);

    if (link === null) return;

    if (latest.current !== null) {
      if (sameServer(latest.current.mediaUrl, link.server)) {
        setInvite({ server: latest.current.mediaUrl, code: link.code });
      } else {
        Alert.alert(
          "Invite for Another Server",
          `This invite is for ${displayHost(link.server)}. Change Server, then open it again.`,
        );
      }

      return;
    }

    const result = await discoverServer(link.server);

    if (connectedMeanwhile()) return;

    if (!result.ok) {
      Alert.alert("Can’t Open Invite", describeConnectFailure(result.failure));

      return;
    }

    setInvite({ server: result.connection.mediaUrl, code: link.code });
    connect(result.connection);
  });

  // Every opening counts, even of the same link twice, so this listens rather than reading the
  // latest URL.
  useEffect(() => {
    void Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener("url", ({ url }) => void open(url));

    return () => subscription.remove();
  }, []);

  return null;
}
