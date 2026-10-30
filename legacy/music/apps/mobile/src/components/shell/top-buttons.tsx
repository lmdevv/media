/**
 * The round buttons at the top of a page while the iPad's sidebar is hidden (A3): show it, and
 * Search, which the sidebar would otherwise hold.
 */
import { PanelLeft, Search } from "lucide-react-native";
import { useCallback } from "react";

import { useRequestSearch } from "@/components/browse/search-activation";
import { IconButton } from "@/components/ui/icon-button";
import { DESTINATIONS } from "@/lib/shell-layout";

import { useOpenPlace } from "./open-place";

/** Opens the Search tab with its field focused. */
export const useOpenSearch = (): (() => void) => {
  const openPlace = useOpenPlace();
  const request = useRequestSearch();

  return useCallback(() => {
    openPlace(DESTINATIONS.search);
    request();
  }, [openPlace, request]);
};

/** Shows the hidden sidebar. */
export function ShowSidebarButton({ onPress }: { readonly onPress: () => void }) {
  return (
    <IconButton
      icon={PanelLeft}
      label="Show sidebar"
      tone="accent"
      size="side"
      className="bg-surface"
      onPress={onPress}
    />
  );
}

/** Opens Search. */
export function SearchButton() {
  const openSearch = useOpenSearch();

  return (
    <IconButton
      icon={Search}
      label="Search"
      size="inline"
      className="bg-surface"
      onPress={openSearch}
    />
  );
}
