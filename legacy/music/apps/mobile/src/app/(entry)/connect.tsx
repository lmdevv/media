/** E02 · Connect, before any server: connecting remembers the server, and the stack moves on. */
import { router } from "expo-router";

import { ConnectForm } from "@/components/entry/connect-form";
import { useConnectionControls } from "@/session/connection";

export default function Connect() {
  const { connect } = useConnectionControls();

  return (
    <ConnectForm
      // Opened from a link or restored on launch, Connect is the stack's root: Back is Welcome.
      onBack={() => (router.canGoBack() ? router.back() : router.replace("/welcome"))}
      onConnected={connect}
    />
  );
}
