/** The account avatar at the top of a tab root; it opens Settings (F01). */
import { useRead } from "@music/sdk/react";
import { router } from "expo-router";
import { Pressable } from "react-native";

import { Avatar } from "./avatar";

/** The avatar as a button: `solid` where the iPad's sidebar is hidden behind a button (A3). */
export function AccountButton({ solid = false }: { readonly solid?: boolean }) {
  const me = useRead("account.me", {});

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Settings"
      onPress={() => router.push("/settings")}
      className="active:opacity-60"
    >
      <Avatar
        name={me === undefined ? "" : (me.name ?? me.email)}
        look={solid ? "solid" : "plain"}
      />
    </Pressable>
  );
}
