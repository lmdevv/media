/**
 * A02 · Library: the totals, the ways into the collection (albums, artists, songs, liked songs,
 * what this iPhone downloaded with its song count (D09), history), and the libraries this account
 * hears, each a plain title without a subtitle. Admins also get Manage, and the libraries they
 * manage open their settings. Scrolled past the title it is A15. On a launch that never reached the
 * server it is D11: the songs on this iPhone, the offline card, and Downloaded first with its size,
 * over the rest dimmed.
 */
import { can } from "@music/commands/permissions";
import { useRead } from "@music/sdk/react";
import type { Href } from "expo-router";
import { router } from "expo-router";
import {
  CircleArrowDown,
  Clock,
  Folder,
  Heart,
  Library as LibraryIcon,
  Lock,
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
import { DEVICE_FAMILY } from "@/lib/this-device";
import { useServerReach } from "@/session/server-reach";

/** Libraries by who hears them: shared with everyone, some people, or only the owner. */
const VISIBILITY_ICONS = { shared: Folder, restricted: Users, private: Lock } as const;

/** What VoiceOver says of who hears a library, which the row shows only as its icon. */
const VISIBILITY_LABELS = {
  shared: "Shared",
  restricted: "Some people",
  private: "Only you",
} as const;

/** One way into the collection. */
interface Category {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly href: Href;
  /**
   * `phone`: what this iPhone downloaded, which opens with no server and leads the list then.
   * `server`: dimmed while the server has never answered.
   */
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

/** D11's order: what plays with no server first. */
const OFFLINE_CATEGORIES: ReadonlyArray<Category> = [
  ...CATEGORIES.filter((category) => category.source === "phone"),
  ...CATEGORIES.filter((category) => category.source === "server"),
];

export default function Library() {
  const home = useRead("library.home", {});
  const libraries = useRead("libraries.list", {});
  const me = useRead("account.me", {});
  const admin = me !== undefined && can(me.role, "admin");
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
          {libraries.map((library) => (
            <Row
              key={library.id}
              title={library.name}
              accessibilityLabel={`${library.name}, ${VISIBILITY_LABELS[library.visibility]}`}
              leading={{ kind: "icon", icon: VISIBILITY_ICONS[library.visibility] }}
              trailing={library.manageable ? <RowChevron /> : undefined}
              dimmed={offline}
              onPress={
                library.manageable && !offline
                  ? () =>
                      router.push({
                        pathname: "/settings/admin/libraries/[id]",
                        params: { id: library.id },
                      })
                  : undefined
              }
            />
          ))}
        </>
      )}
    </TabRoot>
  );
}
