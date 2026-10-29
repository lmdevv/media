/**
 * The Download rows of a sheet (A11 song actions, C08 playlist actions): Download, Cancel
 * download, or Remove download, by where the download stands on this iPhone, and Retry download
 * above Cancel download once songs failed.
 */
import type { DownloadTarget } from "@music/commands/models";
import { errorMessage } from "@music/sdk/errors";
import * as Haptics from "expo-haptics";
import { CircleArrowDown, CircleCheck, CircleMinus, RotateCw } from "lucide-react-native";

import { useDownload } from "@/downloads";
import { downloadRows } from "@/lib/download-row";
import type { DownloadRowLabel } from "@/lib/download-row";

import { Row } from "../ui/row";
import type { TextTone } from "../ui/text";

const ICONS = {
  download: CircleArrowDown,
  retry: RotateCw,
  remove: CircleMinus,
  downloaded: CircleCheck,
} as const;

/** The rows for `target`; `onDone` closes the sheet, `onFailure` shows why adding failed. */
export function DownloadRow({
  target,
  tone,
  onDone,
  onFailure,
}: {
  readonly target: DownloadTarget;
  /** The sheet's icon tone: C08's icons are muted, A11's are not. */
  readonly tone: TextTone;
  readonly onDone: () => void;
  readonly onFailure: (message: string) => void;
}) {
  const download = useDownload(target);

  const press = async (label: DownloadRowLabel) => {
    try {
      if (label.action === "retry") download.retry();
      else await download.toggle();

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onDone();
    } catch (cause) {
      onFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t download it. Try again.");
    }
  };

  return downloadRows(download.status, download.canToggle, download.freedBytes).map((label) => {
    const leading = { kind: "icon", icon: ICONS[label.icon], tone } as const;
    const onPress = label.action === "none" ? undefined : () => void press(label);

    return label.subtitle === null ? (
      <Row key={label.action} title={label.title} leading={leading} onPress={onPress} />
    ) : (
      <Row
        key={label.action}
        title={label.title}
        subtitle={label.subtitle}
        leading={leading}
        onPress={onPress}
      />
    );
  });
}
