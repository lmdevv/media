/** Copying and sharing what a settings screen shows once: keys, invite links, reset links. */
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Share } from "react-native";

/** Puts `text` on the clipboard, with a success tap so the person feels it worked. */
export const copyText = async (text: string): Promise<void> => {
  await Clipboard.setStringAsync(text);
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

/** Opens the iOS share sheet for a link. Dismissing the sheet is not a failure. */
export const shareLink = async (url: string): Promise<void> => {
  await Share.share({ url });
};
