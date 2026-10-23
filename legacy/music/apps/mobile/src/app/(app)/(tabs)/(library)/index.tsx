/**
 * A02 · Library: the totals, the ways into the collection (albums, artists, songs, liked songs,
 * what this iPhone downloaded with its song count (D09), history), and the libraries this account hears, each a plain title without a subtitle. Admins also get Manage, and the libraries they
 * manage open their settings. Scrolled past the title it is A15.
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

import { LinePlaceholder } from "@/components/states/home-states";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { TabRoot } from "@/components/ui/tab-root";
import { Text } from "@/components/ui/text";
import { useDownloadSettings } from "@/downloads";
import { downloadedCount } from "@/lib/downloaded";
import { librarySummary } from "@/lib/format";

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
  /** Shows how many songs this iPhone downloaded. */
  readonly countsDownloads?: boolean;
}

const CATEGORIES: ReadonlyArray<Category> = [
  { title: "Albums", icon: LibraryIcon, href: "/albums" },
  { title: "Artists", icon: Users, href: "/artists" },
  { title: "Songs", icon: Music, href: "/songs" },
  { title: "Liked songs", icon: Heart, href: "/liked" },
  { title: "Downloaded", icon: CircleArrowDown, href: "/downloaded", countsDownloads: true },
  { title: "Listening history", icon: Clock, href: "/history" },
];

export default function Library() {
  const home = useRead("library.home", {});
  const libraries = useRead("libraries.list", {});
  const me = useRead("account.me", {});
  const admin = me !== undefined && can(me.role, "admin");
  const downloaded = downloadedCount(useDownloadSettings().usage);

  return (
    <TabRoot title="Library">
      {home === undefined ? (
        <LinePlaceholder />
      ) : (
        <Text variant="callout" tone="muted">
          {librarySummary(home.stats)}
        </Text>
      )}
      {CATEGORIES.map((category) => (
        <Row
          key={category.title}
          title={category.title}
          leading={{ kind: "icon", icon: category.icon }}
          detail={
            category.countsDownloads === true && downloaded !== null
              ? { text: downloaded, variant: "callout" }
              : undefined
          }
          accessibilityLabel={
            category.countsDownloads === true && downloaded !== null
              ? `${category.title}, ${downloaded}`
              : undefined
          }
          trailing={<RowChevron />}
          onPress={() => router.push(category.href)}
        />
      ))}
      {libraries === undefined || libraries.length === 0 ? null : (
        <>
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
          {libraries.map((library) => (
            <Row
              key={library.id}
              title={library.name}
              accessibilityLabel={`${library.name}, ${VISIBILITY_LABELS[library.visibility]}`}
              leading={{ kind: "icon", icon: VISIBILITY_ICONS[library.visibility] }}
              trailing={library.manageable ? <RowChevron /> : undefined}
              onPress={
                library.manageable
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
