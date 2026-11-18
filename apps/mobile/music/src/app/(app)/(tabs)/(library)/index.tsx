import { can } from "@/lib/capabilities";
import type { Href } from "expo-router";
import { router } from "expo-router";
import {
  CircleArrowDown,
  Clock,
  Folder,
  Heart,
  Library as LibraryIcon,
  Music,
  Users,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { View } from "react-native";

import { LinePlaceholder } from "@/components/states/home-states";
import { OfflineNotice } from "@/components/states/offline-notice";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { TabRoot } from "@/components/ui/tab-root";
import { Text } from "@/components/ui/text";
import { useDownloadSettings } from "@/downloads";
import { downloadedDetail, onThisDevice } from "@/lib/downloaded";
import { librarySummary } from "@/lib/format";
import { LIBRARY_HOME } from "@/lib/details";
import { useMusic, useRead } from "@/lib/platform";
import { useMusicLibraries } from "@/lib/use-libraries";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { useServerReach } from "@/session/server-reach";
import { useMaybeMe } from "@/session/me";

const LEVEL_LABELS = {
  view: "You listen",
  edit: "You edit",
  manage: "You manage",
} as const;

interface Category {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly href: Href;
  readonly source: "phone" | "server";
}

const CATEGORIES: ReadonlyArray<Category> = [
  { title: "Albums", icon: LibraryIcon, href: "/albums", source: "server" },
  { title: "Artists", icon: Users, href: "/artists", source: "server" },
  { title: "Songs", icon: Music, href: "/songs", source: "server" },
  { title: "Liked songs", icon: Heart, href: "/liked", source: "server" },
  { title: "Downloaded", icon: CircleArrowDown, href: "/downloaded", source: "phone" },
  { title: "Listening history", icon: Clock, href: "/history", source: "server" },
];

const OFFLINE_CATEGORIES: ReadonlyArray<Category> = [
  ...CATEGORIES.filter((category) => category.source === "phone"),
  ...CATEGORIES.filter((category) => category.source === "server"),
];

export default function Library() {
  const home = useRead(useMusic().library.home, LIBRARY_HOME);
  const libraries = useMusicLibraries();
  const me = useMaybeMe();
  const admin = me !== null && can(me, "admin");
  const { usage } = useDownloadSettings();
  const offline = useServerReach() === "offline";
  const downloaded = downloadedDetail(usage, offline);

  return (
    <TabRoot title="Library">
      {offline ? (
        <Text variant="callout" tone="muted">
          {onThisDevice(usage, DEVICE_FAMILY)}
        </Text>
      ) : home === undefined ? (
        <LinePlaceholder />
      ) : (
        <Text variant="callout" tone="muted">
          {librarySummary(home.stats)}
        </Text>
      )}
      <OfflineNotice variant="card" className="pt-3 pb-2" />
      {(offline ? OFFLINE_CATEGORIES : CATEGORIES).map((category) => {
        const phone = category.source === "phone";
        const detail = phone ? downloaded : null;
        const dimmed = offline && !phone;

        return (
          <Row
            key={category.title}
            title={category.title}
            leading={{ kind: "icon", icon: category.icon }}
            detail={detail === null ? undefined : { text: detail, variant: "callout" }}
            trailing={<RowChevron />}
            dimmed={dimmed}
            onPress={dimmed ? undefined : () => router.push(category.href)}
          />
        );
      })}
      {libraries === undefined || libraries.length === 0 ? null : (
        <>
          <View
            className={offline ? "opacity-disabled" : ""}
            pointerEvents={offline ? "none" : "auto"}
          >
            <SectionHeader
              title="Your libraries"
              action={
                admin
                  ? {
                      kind: "link",
                      label: "Manage",
                      onPress: () => router.push("/settings/admin/libraries"),
                    }
                  : undefined
              }
            />
          </View>
          {libraries.map((library) => {
            const manageable = admin && library.level === "manage";

            return (
              <Row
                key={library.libraryId}
                title={library.name}
                accessibilityLabel={`${library.name}, ${LEVEL_LABELS[library.level]}`}
                leading={{ kind: "icon", icon: Folder }}
                trailing={manageable ? <RowChevron /> : undefined}
                dimmed={offline}
                onPress={
                  manageable && !offline
                    ? () =>
                        router.push({
                          pathname: "/settings/admin/libraries/[id]",
                          params: { id: library.libraryId },
                        })
                    : undefined
                }
              />
            );
          })}
        </>
      )}
    </TabRoot>
  );
}
