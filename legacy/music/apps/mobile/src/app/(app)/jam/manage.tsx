/**
 * D09 · Manage your Jam, the host's sheet: a new invite link (the old one stops working), remove a
 * person (People, D03), or end the Jam (D10).
 */
import { errorMessage } from "@music/sdk/errors";
import { useRun } from "@music/sdk/react";
import { router } from "expo-router";
import { RefreshCw, Users, X } from "lucide-react-native";
import { useState } from "react";

import { Row, RowChevron } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";

/** Where the new link stands. */
type Relink =
  | { readonly state: "idle" }
  | { readonly state: "pending" }
  | { readonly state: "done" }
  | { readonly state: "failed"; readonly message: string };

const RELINK_LINE = {
  idle: "The old link stops working",
  pending: "Making a new link…",
  done: "Done. Only the new link works now",
} as const satisfies Record<Exclude<Relink["state"], "failed">, string>;

export default function ManageJam() {
  const relink = useRun("jam.relink");
  const [status, setStatus] = useState<Relink>({ state: "idle" });

  const newLink = async () => {
    setStatus({ state: "pending" });

    try {
      await relink({});
      setStatus({ state: "done" });
    } catch (cause) {
      setStatus({
        state: "failed",
        message: cause instanceof Error ? errorMessage(cause) : "Couldn’t make a new link.",
      });
    }
  };

  return (
    <SheetLayout title="Manage your Jam" subtitle="Only you, as host, can change these.">
      <Row
        title="New invite link"
        subtitle={status.state === "failed" ? status.message : RELINK_LINE[status.state]}
        leading={{ kind: "icon", icon: RefreshCw, tone: "muted" }}
        trailing={<RowChevron />}
        {...(status.state === "pending" ? {} : { onPress: () => void newLink() })}
      />
      <Row
        title="Remove a person"
        subtitle="They can’t rejoin using this link"
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        trailing={<RowChevron />}
        onPress={() => {
          router.back();
          router.push("/jam/people");
        }}
      />
      <Row
        title="End Jam"
        subtitle="Everyone returns to their own music"
        leading={{ kind: "icon", icon: X, tone: "muted" }}
        trailing={<RowChevron />}
        onPress={() => {
          router.replace("/jam/end");
        }}
      />
    </SheetLayout>
  );
}
