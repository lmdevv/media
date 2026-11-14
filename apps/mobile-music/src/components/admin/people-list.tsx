import { router } from "expo-router";
import { Plus, Users } from "lucide-react-native";

import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowChevron } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import type { Me } from "@/lib/models";
import { inviteLine, inviteTitle, openInvites, personLine, personName } from "@/lib/people";

import { useNow } from "@/components/settings/use-now";

import { useInvites, usePeople } from "./data";

const newInvite = () => router.push("/settings/admin/people/invite");

/** People and open invites, each opening its own page. */
export function PeopleList({ me }: { readonly me: Me }) {
  const people = usePeople();
  const invites = useInvites();
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
          key={person.userId}
          leading={{ kind: "icon", icon: Users, tone: "muted" }}
          title={personName(person)}
          subtitle={personLine(person, me.userId)}
          trailing={<RowChevron />}
          onPress={() =>
            router.push({ pathname: "/settings/admin/people/[id]", params: { id: person.userId } })
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
            key={invite.inviteId}
            leading={{ kind: "icon", icon: Users, tone: "muted" }}
            title={inviteTitle(invite)}
            subtitle={inviteLine(invite, now)}
            trailing={<RowChevron />}
            onPress={() =>
              router.push({
                pathname: "/settings/admin/invites/[id]",
                params: { id: invite.inviteId },
              })
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
