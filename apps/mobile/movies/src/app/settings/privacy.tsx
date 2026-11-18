import { Sheet } from "@/components/title/sheet";
import { displayHost } from "@/lib/local-network";
import { useServer } from "@/session/connection";

export default function Privacy() {
  const server = useServer();

  return (
    <Sheet
      title="Privacy"
      subtitle={`Your account and watch history stay on ${displayHost(server.mediaUrl)}. This app talks to that server only, and keeps its sign-in in this iPhone’s keychain.`}
    />
  );
}
