/**
 * The download ring in an album's or playlist's header, beside More (Paper's downloads proposal,
 * variant A, D01 and D04): tap to download, tap the stop square to cancel, and tap a finished
 * download to be asked before it is removed.
 */
import type { AlbumId, PlaylistId } from "@music/commands/ids";
import * as Haptics from "expo-haptics";
import { Pressable } from "react-native";

import { useSave } from "@/components/states/save-failure";
import { useDownload } from "@/downloads";
import { downloadControl } from "@/lib/download-control";

import { DownloadRingGlyph } from "./download-glyphs";
import { openRemoveDownload } from "./remove-download";

/** A collection this phone can keep. */
type CollectionTarget =
  | { readonly kind: "album"; readonly id: AlbumId }
  | { readonly kind: "playlist"; readonly id: PlaylistId };

/** A 44pt nav bar button with the download ring of `target`, named `title`. */
export function DownloadButton({
  target,
  title,
}: {
  readonly target: CollectionTarget;
  readonly title: string;
}) {
  const download = useDownload(target);
  const save = useSave();
  const control = downloadControl(download.status, download.canToggle);

  const press = () => {
    if (control.press === "confirm-remove") {
      openRemoveDownload(target, title);

      return;
    }

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Cancelling fails only when this phone can't record it; adding also needs the server.
    void save(
      download.toggle,
      control.press === "cancel" ? `${title} is still downloading.` : `${title} isn’t downloading.`,
    );
  };

  const off = control.press === "none";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={control.label}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={press}
      className={`size-hit-target items-center justify-center rounded-full active:opacity-60 ${
        off && control.ring.kind === "idle" ? "opacity-disabled" : ""
      }`}
    >
      <DownloadRingGlyph ring={control.ring} />
    </Pressable>
  );
}
