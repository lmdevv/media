import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";

import { Sheet, useSheetExit } from "@/components/title/sheet";
import { Button } from "@/components/ui/button";
import { describeFailure } from "@/lib/failure";

/** Props for `ConfirmSheet`. */
export interface ConfirmSheetProps {
  readonly title: string;
  readonly description: string;
  readonly action: string;
  readonly icon?: LucideIcon;
  /** Does the destructive work; the sheet closes when it resolves and stays open when it fails. */
  readonly onConfirm: () => Promise<void>;
  /**
   * Leaves closing to the work itself, such as signing out, which replaces every screen when the
   * session ends.
   */
  readonly closesItself?: boolean;
}

/** A sheet that asks before something destructive happens. */
export function ConfirmSheet({
  title,
  description,
  action,
  icon,
  onConfirm,
  closesItself = false,
}: ConfirmSheetProps) {
  const exit = useSheetExit();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);

    try {
      await onConfirm();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (!closesItself) exit.close();
    } catch (cause) {
      setError(describeFailure(cause));
      setBusy(false);
    }
  };

  return (
    <Sheet title={title} subtitle={description} error={error} exit={exit}>
      <Button
        label={action}
        variant="destructive"
        {...(icon === undefined ? {} : { icon })}
        busy={busy}
        onPress={() => void confirm()}
      />
      <Button label="Cancel" variant="plain" onPress={exit.close} />
    </Sheet>
  );
}
