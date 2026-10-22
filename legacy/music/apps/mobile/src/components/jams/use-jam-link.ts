/**
 * The Jam's link on this server, with the native share sheet and a copy that says it worked: the
 * button reads "Copied" for a moment, Paper's quiet confirmation.
 */
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Share } from "react-native";

import { jamLink } from "@/lib/jam";
import { useConnection } from "@/session/connection";

const COPIED_MS = 2000;

/** Copies `text`, then confirms with a haptic and `done`. */
const copyText = async (text: string, done: () => void): Promise<void> => {
  await Clipboard.setStringAsync(text);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  done();
};

/** What the share and copy buttons need. */
export interface JamLinkActions {
  readonly link: string;
  readonly share: () => void;
  readonly copy: () => void;
  /** True for a moment after a copy. */
  readonly copied: boolean;
}

/** The link for the Jam `code`, and ways to send it. */
export const useJamLink = (code: string): JamLinkActions => {
  const { origin } = useConnection();
  const link = jamLink(origin, code);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);

  useEffect(() => {
    if (copiedAt === null) return undefined;

    const timer = setTimeout(() => {
      setCopiedAt(null);
    }, COPIED_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [copiedAt]);

  return {
    link,
    share: () => {
      void Share.share({ message: link });
    },
    copy: () => {
      void copyText(link, () => {
        setCopiedAt(Date.now());
      });
    },
    copied: copiedAt !== null,
  };
};
