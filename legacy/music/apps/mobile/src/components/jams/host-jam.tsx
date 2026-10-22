/**
 * D02 and H09 · the host's Jam: the link as a QR code, Share and Copy, and who is in the Jam or
 * waiting to join. The rows open People (D03); the gear opens the settings (D04).
 */
import type { Jam } from "@music/commands/models";
import { router } from "expo-router";
import { Settings, Share as ShareIcon, Users } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Page } from "@/components/ui/page";
import { Row, RowCheck, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { peopleRow, requestsRow } from "@/lib/jam";
import { useNowPlaying } from "@/player";
import type { PlayerRole } from "@/player";

import { QrCode } from "./qr-code";
import { useJamLink } from "./use-jam-link";

/** Where the host's music plays, after "Host". */
const hostLine = (role: PlayerRole): string => {
  if (role.kind === "local") return "Host · This iPhone";

  return role.kind === "remote" ? `Host · Playing on ${role.device.name}` : "Host";
};

const openPeople = () => {
  router.push("/jam/people");
};

/** The host's Jam home. */
export function HostJam({ jam }: { readonly jam: Jam }) {
  const { role } = useNowPlaying();
  const { link, share, copy, copied } = useJamLink(jam.code);
  const people = peopleRow(jam.members);
  const requests = requestsRow(jam.members);

  return (
    <Page
      title="Your Jam"
      bottom="plain"
      trailing={
        <IconButton
          icon={Settings}
          label="Jam settings"
          onPress={() => {
            router.push("/jam/settings");
          }}
        />
      }
    >
      <View className="items-center py-6">
        <QrCode value={link} label="QR code for the Jam link" />
      </View>
      <View className="flex-row gap-3">
        <Button label="Share link" icon={ShareIcon} onPress={share} className="flex-1" />
        <Button
          label={copied ? "Copied" : "Copy link"}
          variant="secondary"
          onPress={copy}
          className="flex-1"
        />
      </View>
      <SectionHeader
        title="In this Jam"
        action={{
          kind: "link",
          label: "Manage",
          onPress: () => {
            router.push("/jam/manage");
          },
        }}
      />
      <Row
        title="You"
        subtitle={hostLine(role)}
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        trailing={<RowCheck />}
      />
      <Row
        title={people.title}
        subtitle={people.subtitle}
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        trailing={<RowChevron />}
        onPress={openPeople}
      />
      {requests === null ? null : (
        <Row
          title={requests.title}
          subtitle={requests.subtitle}
          active
          leading={{ kind: "icon", icon: Users, tone: "accent" }}
          trailing={<RowChevron />}
          onPress={openPeople}
        />
      )}
    </Page>
  );
}
