/**
 * F09 · People: everyone on the server with their role, then the invites that still work. The
 * list stays in the page's scroll: it is a household's accounts, each row is a plain view with no
 * subscription of its own, and capping it would hide people an admin must reach.
 */
import type { User } from "@music/commands/models";
import { useRead } from "@music/sdk/react";
import { router } from "expo-router";
import { Plus, Users } from "lucide-react-native";

import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { inviteLine, inviteTitle, openInvites, personLine, personName } from "@/lib/people";

import { useNow } from "@/components/settings/use-now";

const newInvite = () => router.push("/settings/admin/people/invite");

/** People and open invites, each opening its own page. */
export function PeopleList({ me }: { readonly me: User }) {
  const people = useRead("people.list", {});
  const invites = useRead("invites.list", {});
  const now = useNow(60_000);
  const open = invites === undefined ? undefined : openInvites(invites, now);

  return (
    <Page
      title="People"
      bottom="plain"
      trailing={<IconButton icon={Plus} label="New invite" onPress={newInvite} />}
    >
      {people?.map((person) => (
        <Row
          key={person.id}
          leading={{ kind: "icon", icon: Users, tone: "muted" }}
          title={personName(person)}
          subtitle={personLine(person, me.id)}
          trailing={<RowChevron />}
          onPress={() =>
            router.push({ pathname: "/settings/admin/people/[id]", params: { id: person.id } })
          }
        />
      ))}
      <SectionHeader
        title="Invites"
        action={{ kind: "link", label: "New invite", onPress: newInvite }}
      />
      {open?.length === 0 ? (
        <Text variant="secondary" tone="muted" className="pb-4">
          No open invites.
        </Text>
      ) : (
        open?.map((invite) => (
          <Row
            key={invite.id}
            leading={{ kind: "icon", icon: Users, tone: "muted" }}
            title={inviteTitle(invite)}
            subtitle={inviteLine(invite, now)}
            trailing={<RowChevron />}
            onPress={() =>
              router.push({ pathname: "/settings/admin/invites/[id]", params: { id: invite.id } })
            }
          />
        ))
      )}
      <Notice
        icon={Users}
        title="Everyone gets their own space"
        body="Playlists, likes, history, and devices are personal."
      />
    </Page>
  );
}
