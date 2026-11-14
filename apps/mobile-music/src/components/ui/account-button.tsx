import { router } from "expo-router";
import { Pressable } from "react-native";

import { Avatar } from "./avatar";
import { useMyName } from "@/session/me";

/** The avatar as a button: `solid` where the iPad's sidebar is hidden behind a button (A3). */
export function AccountButton({ solid = false }: { readonly solid?: boolean }) {
  const name = useMyName();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Settings"
      onPress={() => router.push("/settings")}
      className="active:opacity-60"
    >
      <Avatar name={name} look={solid ? "solid" : "plain"} />
    </Pressable>
  );
}
