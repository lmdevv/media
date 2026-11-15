import { router } from "expo-router";
import { Folder, Lock, Monitor, RotateCw, Settings, Users } from "lucide-react-native";

import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { librariesSummary } from "@/lib/libraries";
import { hostOf } from "@/lib/links";
import type { Me } from "@/lib/models";
import { openInvites, peopleSummary } from "@/lib/people";
import { useConnection } from "@/session/connection";

import { NavGlyph } from "@/components/settings/nav-glyph";
import { useNow } from "@/components/settings/use-now";

import { useInvites, useManagedLibraries, usePeople } from "./data";

/** The administration hub for an admin or the owner. */
export function AdminHub({ me }: { readonly me: Me }) {
  const { mediaUrl } = useConnection();
  const people = usePeople();
  const invites = useInvites();
  const libraries = useManagedLibraries();
  const now = useNow(60_000);

  return (
    <Page title="Administration" bottom="plain" trailing={<NavGlyph icon={Settings} />}>
      <Row
        leading={{ kind: "icon", icon: Monitor, tone: "muted" }}
        title={hostOf(mediaUrl)}
        subtitle={me.role === "owner" ? "You’re the server owner" : "You’re an admin"}
      />
      <Row
        leading={{ kind: "icon", icon: Users, tone: "muted" }}
        title="People & invites"
        subtitle={
          people === undefined || invites === undefined
            ? ""
            : peopleSummary(people.length, openInvites(invites, now).length)
        }
        trailing={<RowChevron />}
        onPress={() => router.push("/settings/admin/people")}
      />
      <Row
        leading={{ kind: "icon", icon: Folder, tone: "muted" }}
        title="Libraries"
        subtitle={libraries === undefined ? "" : librariesSummary(libraries)}
        trailing={<RowChevron />}
        onPress={() => router.push("/settings/admin/libraries")}
      />
      <Row
        leading={{ kind: "icon", icon: RotateCw, tone: "muted" }}
        title="Jobs"
        subtitle="Scans and background activity"
        trailing={<RowChevron />}
        onPress={() => router.push("/settings/admin/jobs")}
      />
      <Row
        leading={{ kind: "icon", icon: Settings, tone: "muted" }}
        title="Server settings"
        subtitle="Lyrics lookups"
        trailing={<RowChevron />}
        onPress={() => router.push("/settings/admin/server")}
      />
      <Notice
        icon={Lock}
        title="Admin tools, in your pocket"
        body="These controls use the same permissions as the web app and CLI."
      />
    </Page>
  );
}
