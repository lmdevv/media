import type { AlbumId, PlaylistId } from "@music/commands/ids";
import * as Haptics from "expo-haptics";
import { Pressable } from "react-native";

import { useSave } from "@/components/states/save-failure";
import { useDownload } from "@/downloads";
import { downloadControl } from "@/lib/download-control";
import { DEVICE_FAMILY } from "@/lib/this-device";

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
  const control = downloadControl(download.status, download.canToggle, DEVICE_FAMILY);

  const press = () => {
    if (control.press === "confirm-remove") {
      openRemoveDownload(target, title);

      return;
    }

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

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
