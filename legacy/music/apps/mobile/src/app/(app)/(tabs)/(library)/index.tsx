/**
 * A02 · Library: the totals, the ways into the collection (albums, artists, songs, liked songs,
 * history), and the libraries this account hears. Admins also get Manage, and the libraries they
 * manage open their settings. Scrolled past the title it is A15.
 */
import { can } from "@music/commands/permissions";
import { useRead } from "@music/sdk/react";
import type { Href } from "expo-router";
import { router } from "expo-router";
import {
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
import { countOf, libraryLine, librarySummary } from "@/lib/format";

/** Libraries by who hears them: shared with everyone, some people, or only the owner. */
const VISIBILITY_ICONS = { shared: Folder, restricted: Users, private: Lock } as const;

/** One way into the collection. */
interface Category {
  readonly title: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
  readonly href: Href;
}

export default function Library() {
  const home = useRead("library.home", {});
  const libraries = useRead("libraries.list", {});
  const me = useRead("account.me", {});
  const admin = me !== undefined && can(me.role, "admin");

  const categories: ReadonlyArray<Category> = [
    { title: "Albums", subtitle: "Every record, in one place", icon: LibraryIcon, href: "/albums" },
    { title: "Artists", subtitle: "The people behind your music", icon: Users, href: "/artists" },
    {
      title: "Songs",
      subtitle:
        home === undefined ? "Every song" : `Browse all ${countOf(home.stats.tracks, "song")}`,
      icon: Music,
      href: "/songs",
    },
    { title: "Liked songs", subtitle: "Songs you’ve liked", icon: Heart, href: "/liked" },
    {
      title: "Listening history",
      subtitle: "Your recent listening",
      icon: Clock,
      href: "/history",
    },
  ];

  return (
    <TabRoot title="Library">
      {home === undefined ? (
        <LinePlaceholder />
      ) : (
        <Text variant="callout" tone="muted">
          {librarySummary(home.stats)}
        </Text>
      )}
      {categories.map((category) => (
        <Row
          key={category.title}
          title={category.title}
          subtitle={category.subtitle}
          leading={{ kind: "icon", icon: category.icon }}
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
              subtitle={libraryLine(library.visibility, library.trackCount)}
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
