/**
 * F01 · Settings: the account, then personal settings, Actions, joining a Jam, and, for admins
 * and the owner only, server administration. Rows a role may not use are left out, not disabled.
 */
import { can } from "@music/commands/permissions";
import { router } from "expo-router";
import { Command, Info, Key, Monitor, Music, Settings, Users } from "lucide-react-native";
import { View } from "react-native";

import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { Text } from "@/components/ui/text";
import { hostOf } from "@/lib/links";
import { accountLine } from "@/lib/people";
import { useConnection } from "@/session/connection";

import { useMe } from "./access";
import { NavGlyph } from "./nav-glyph";

/** Personal settings and the way into everything else. */
export function SettingsHub() {
  const me = useMe();
  const { origin } = useConnection();

  return (
    <Page title="Settings" bottom="plain" trailing={<NavGlyph icon={Info} />}>
      {me === undefined ? null : (
        <>
          <Row
            leading={{ kind: "icon", icon: Users, tone: "muted" }}
            title={me.name ?? me.email}
            subtitle={accountLine(me)}
            trailing={<RowChevron />}
            onPress={() => router.push("/settings/account")}
          />
          <Row
            leading={{ kind: "icon", icon: Music, tone: "muted" }}
            title="Playback & appearance"
            subtitle="Quality, theme, and autoplay"
            trailing={<RowChevron />}
            onPress={() => router.push("/settings/playback")}
          />
          <Row
            leading={{ kind: "icon", icon: Monitor, tone: "muted" }}
            title="Devices"
            subtitle="Listen here or hand off"
            trailing={<RowChevron />}
            onPress={() => router.push("/player/devices")}
          />
          {can(me.role, "keys") ? (
            <Row
              leading={{ kind: "icon", icon: Key, tone: "muted" }}
              title="API keys"
              subtitle="Connect your CLI and agents"
              trailing={<RowChevron />}
              onPress={() => router.push("/settings/keys")}
            />
          ) : null}
          <Row
            leading={{ kind: "icon", icon: Command, tone: "muted" }}
            title="Actions"
            subtitle="Every [music] command"
            trailing={<RowChevron />}
            onPress={() => router.push("/settings/actions")}
          />
          <Row
            leading={{ kind: "icon", icon: Users, tone: "muted" }}
            title="Join a Jam"
            subtitle="Enter a Jam link or code"
            trailing={<RowChevron />}
            onPress={() => router.push("/jam/join")}
          />
          {can(me.role, "admin") ? (
            <Row
              leading={{ kind: "icon", icon: Settings, tone: "muted" }}
              title="Server administration"
              subtitle="People, libraries, and jobs"
              trailing={<RowChevron />}
              onPress={() => router.push("/settings/admin")}
            />
          ) : null}
        </>
      )}
      <View className="pt-mobile-edge">
        <Text variant="mono" tone="muted">
          {`[music] · ${hostOf(origin)}`.toUpperCase()}
        </Text>
      </View>
    </Page>
  );
}
