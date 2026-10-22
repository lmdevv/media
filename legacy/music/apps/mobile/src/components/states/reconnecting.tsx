/**
 * G04 · Reconnecting: the server dropped after the app had reached it. The notice sits under a
 * tab root's title and never blocks: what is on screen stays usable from cache, and the queue
 * keeps playing. Convex reconnects on its own (at most 16 seconds apart), and the notice goes
 * once it does. A server that stops answering without closing the socket only shows as a closed
 * socket after Convex's 60 second silence check, so a request left waiting counts too: the player
 * sends one at least every 30 seconds.
 */
import { useConvexConnectionState } from "convex/react";
import { Wifi } from "lucide-react-native";
import { useEffect, useState } from "react";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import { Notice } from "@/components/ui/notice";

/**
 * How long the connection may be down, or a request unanswered, before G04 says so: a blip or a
 * return from the background recovers sooner, without a flash.
 */
const GRACE_MS = 5000;

/** Whether the connection has been down, or a request waiting, for `GRACE_MS` after it was up. */
const useReconnecting = (): boolean => {
  const { isWebSocketConnected, hasEverConnected, hasInflightRequests } =
    useConvexConnectionState();

  const waiting = !isWebSocketConnected || hasInflightRequests;
  const [late, setLate] = useState(false);

  useEffect(() => {
    setLate(false);

    if (!waiting) return undefined;

    const timer = setTimeout(() => setLate(true), GRACE_MS);

    return () => clearTimeout(timer);
  }, [waiting]);

  return late && hasEverConnected;
};

/** The reconnecting notice while the server is away; nothing while it's there. */
export function ReconnectingNotice() {
  if (!useReconnecting()) return null;

  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(180)} className="mb-1">
      <Notice
        icon={Wifi}
        title="Reconnecting to your server"
        body="Your queue is saved. Changes will be available when you reconnect."
      />
    </Animated.View>
  );
}
