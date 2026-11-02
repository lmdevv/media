import { router } from "expo-router";

import { ConnectForm } from "@/components/entry/connect-form";
import { useConnection } from "@/session/connection";

export default function ChangeServer() {
  const { origin, connect } = useConnection();

  return (
    <ConnectForm
      onBack={() => router.back()}
      onConnected={(next) => {
        if (next.origin === origin) router.back();
        else connect(next);
      }}
    />
  );
}
