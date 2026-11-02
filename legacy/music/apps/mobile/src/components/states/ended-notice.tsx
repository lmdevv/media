import { UserX, Users } from "lucide-react-native";

import { Notice } from "@/components/ui/notice";
import { useEndedSession } from "@/session/session-phase";

/** A notice over Sign in after the account was removed; nothing otherwise. */
export function EndedNotice() {
  const { ended } = useEndedSession();

  if (ended?.reason !== "removed") return null;

  return ended.guest ? (
    <Notice
      icon={Users}
      title="The Jam has ended"
      body="Guest accounts go when their Jam ends. Ask the host for a new link to join again."
      className="mb-2"
    />
  ) : (
    <Notice
      icon={UserX}
      title="This account was removed"
      body="An admin removed it from this server. Ask them for a new invite, or sign in with another account."
      className="mb-2"
    />
  );
}
