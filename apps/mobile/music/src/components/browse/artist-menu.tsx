import { Button, Host, Menu, RNHostView } from "@expo/ui/swift-ui";
import { accessibilityLabel } from "@expo/ui/swift-ui/modifiers";
import type { CreditedItem } from "@media/contracts/artist-credits";
import type { ReactElement } from "react";
import { Pressable, View } from "react-native";
import type { GestureResponderEvent } from "react-native";

import { creditArtists } from "@/lib/credits";
import type { ArtistId } from "@/lib/models";

const FILL = { alignSelf: "stretch" } as const;

/**
 * A control that opens an artist `item` credits: its only artist directly, or, for a song or an
 * album crediting several, the one picked from a native menu listing each, in the order its line
 * shows them. `children` draws the control and takes no presses of its own. The menu takes its
 * row's width, so a long line truncates inside it rather than overflowing.
 */
export function ArtistMenu({
  item,
  label,
  role = "link",
  className = "",
  onOpen,
  children,
}: {
  readonly item: CreditedItem<ArtistId>;
  /** What VoiceOver reads for the control. */
  readonly label: string;
  /** A link names the artist; a button, such as Go to artist, says what it does. */
  readonly role?: "link" | "button";
  /** Classes for the control of a single artist, such as `self-start` to fit its text. */
  readonly className?: string;
  /** Opens the artist; `press` is the touch on a single artist's control, absent for a menu. */
  readonly onOpen: (artistId: ArtistId, press?: GestureResponderEvent) => void;
  readonly children: ReactElement;
}) {
  const artists = creditArtists(item);
  const [first, ...others] = artists;

  if (first === undefined || others.length === 0) {
    const artistId = first?.artistId ?? item.artistId;

    return (
      <Pressable
        accessibilityRole={role}
        accessibilityLabel={label}
        accessibilityHint={role === "link" ? "Opens the artist" : undefined}
        onPress={(press) => onOpen(artistId, press)}
        className={`active:opacity-60 ${className}`}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <Host matchContents={{ vertical: true }} style={FILL}>
      <Menu
        label={
          <RNHostView matchContents={{ vertical: true }}>
            <View
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {children}
            </View>
          </RNHostView>
        }
        modifiers={[accessibilityLabel(label)]}
      >
        {artists.map((artist) => (
          <Button
            key={artist.artistId}
            label={artist.name}
            systemImage="music.microphone"
            onPress={() => onOpen(artist.artistId)}
          />
        ))}
      </Menu>
    </Host>
  );
}
