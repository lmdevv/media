import { User } from "lucide-react-native";

import { useImportState, useReview } from "@/components/owner/import-state";
import type { Preview } from "@/components/owner/import-state";
import { OwnerScreen, showActions } from "@/components/owner/parts";
import { ListRow } from "@/components/ui/list-row";
import { Text } from "@/components/ui/text";
import { choiceLabel } from "@/lib/migration";

function UserChoices({ preview }: { readonly preview: Preview }) {
  const { rows, choose } = useReview(preview);

  return (
    <>
      {rows.map((row) => (
        <ListRow
          key={row.sourceUserId}
          icon={User}
          title={row.name}
          detail={choiceLabel(row)}
          disabled={choose.busy}
          onPress={() =>
            showActions(
              row.name,
              row.options.map((option) => ({
                label: option.label,
                onPress: () => void choose.run(row.sourceUserId, option.value),
              })),
            )
          }
        />
      ))}
      {choose.error === null ? null : (
        <Text variant="meta" tone="danger">
          {choose.error}
        </Text>
      )}
    </>
  );
}

export default function ImportUsers() {
  const { preview } = useImportState();

  return (
    <OwnerScreen title="Users" fallback="/owner/import">
      {preview === null ? null : <UserChoices preview={preview} />}
    </OwnerScreen>
  );
}
