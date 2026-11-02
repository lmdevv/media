import { router } from "expo-router";

import { ConnectForm } from "@/components/entry/connect-form";
import { useConnectionControls } from "@/session/connection";

export default function Connect() {
  const { connect } = useConnectionControls();

  return (
    <ConnectForm
      onBack={() => (router.canGoBack() ? router.back() : router.replace("/welcome"))}
      onConnected={connect}
    />
  );
}
