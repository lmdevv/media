/**
 * E02 · Connect, from Sign in's "Use a different server". The same server pops back to Sign in.
 * Another server remounts the whole stack under its own session, which opens on that server's
 * first screen by itself; popping as well would land on the new stack, with nothing to go back to.
 */
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
