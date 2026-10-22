/**
 * Paper's confirmation sheet (B10, C12, D10, F07, F13, F21, F24, F25): a title, what will happen,
 * the confirm action, and Cancel. Paper draws these as sheets, so they are never `Alert.alert`.
 */
import { errorMessage } from "@music/sdk/errors";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "./button";
import { SheetLayout } from "./sheet-layout";
import { Text } from "./text";

/** Props for `ConfirmSheet`. */
export interface ConfirmSheetProps {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  /** What the confirm button says while the action runs, such as `Removing…`. */
  readonly pendingLabel: string;
  /** What the button that backs out says, such as `Keep queue` (B10) or `Keep playlist` (C12). */
  readonly cancelLabel?: string;
  /** Destructive for removals; primary for consequential but safe steps (F22). */
  readonly tone?: "destructive" | "primary";
  /**
   * Runs the action, then moves on: dismiss the sheet, or go where the result lives. A rejection
   * keeps the sheet open with the server's message, so the person can retry or cancel.
   */
  readonly onConfirm: () => Promise<void>;
}

/** Asks before a consequential action, and runs it with pending and failure states. */
export function ConfirmSheet({
  title,
  body,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Cancel",
  tone = "destructive",
  onConfirm,
}: ConfirmSheetProps) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const confirm = async () => {
    setPending(true);
    setFailure(null);

    try {
      await onConfirm();
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <SheetLayout
      title={title}
      subtitle={body}
      actions={
        <>
          <Button
            label={confirmLabel}
            pendingLabel={pendingLabel}
            pending={pending}
            variant={tone}
            onPress={() => void confirm()}
          />
          <Button label={cancelLabel} variant="secondary" onPress={() => router.back()} />
        </>
      }
    >
      {failure === null ? null : (
        <View className="pb-2">
          <Text variant="calloutMedium" tone="danger" accessibilityLiveRegion="polite">
            {failure}
          </Text>
        </View>
      )}
    </SheetLayout>
  );
}
