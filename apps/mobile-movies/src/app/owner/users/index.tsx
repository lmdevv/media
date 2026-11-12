import { ROLE_LABELS, expiryLine } from "@media/mobile-core/accounts";
import type { PendingInvite } from "@media/mobile-core/accounts";
import { describeFailure } from "@media/mobile-core/failure";
import { useHousehold, usePendingInvites, useRevokeInvite } from "@media/mobile-core/use-accounts";
import { router } from "expo-router";
import { Link, Plus, User } from "lucide-react-native";
import { Alert } from "react-native";

import {
  OwnerScreen,
  PagedView,
  SectionHeading,
  showActions,
  useNow,
} from "@/components/owner/parts";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";

const invite = () => router.push("/owner/users/invite");

const DAY_MS = 86_400_000;

function PendingInviteRow({ invite: pending }: { readonly invite: PendingInvite }) {
  const revoke = useRevokeInvite();
  const now = useNow(60_000);
  const label = `${ROLE_LABELS[pending.role]} Invite`;

  return (
    <ListRow
      icon={Link}
      title={label}
      detail={
        pending.expiresAt <= now
          ? "Expired"
          : expiryLine(Math.max(1, Math.ceil((pending.expiresAt - now) / DAY_MS)))
      }
      onPress={() =>
        showActions(label, [
          {
            label: "Revoke Invite",
            destructive: true,
            onPress: () => {
              revoke(pending).catch((cause: unknown) => {
                Alert.alert("Couldn’t Revoke Invite", describeFailure(cause));
              });
            },
          },
        ])
      }
    />
  );
}

export default function UsersAndInvites() {
  const users = useHousehold();
  const invites = usePendingInvites();

  return (
    <OwnerScreen
      title="Users & Invites"
      trailing={<IconButton icon={Plus} label="Invite Someone" onPress={invite} />}
    >
      <PagedView list={users}>
        {(rows) =>
          rows.map((user) => (
            <ListRow
              key={user.userId}
              icon={User}
              title={user.username}
              detail={ROLE_LABELS[user.role]}
              onPress={() =>
                router.push({ pathname: "/owner/users/[userId]", params: { userId: user.userId } })
              }
            />
          ))
        }
      </PagedView>
      {invites.status === "ready" && invites.rows.length === 0 ? null : (
        <>
          <SectionHeading>Pending Invites</SectionHeading>
          <PagedView list={invites}>
            {(rows) => rows.map((each) => <PendingInviteRow key={each.inviteId} invite={each} />)}
          </PagedView>
        </>
      )}
      <Button label="Invite Someone" icon={Plus} onPress={invite} />
    </OwnerScreen>
  );
}
