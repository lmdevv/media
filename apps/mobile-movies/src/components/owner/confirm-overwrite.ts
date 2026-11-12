import { overtakenLine } from "@media/mobile-core/edits";
import { Alert } from "react-native";

/**
 * Asks before a save writes over fields another person changed while this one edited them, named
 * in `names`. Resolves true at once when there are none, and false when the person cancels.
 */
export const confirmOverwrite = (names: ReadonlyArray<string>): Promise<boolean> =>
  names.length === 0
    ? Promise.resolve(true)
    : new Promise((resolve) => {
        Alert.alert(
          overtakenLine(names),
          "Saving replaces their change with yours.",
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: "Save Anyway", style: "destructive", onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      });
