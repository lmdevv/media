/**
 * Paper's labeled field: a 14/20 semibold label over a 56pt surface input with 16pt text, an
 * optional muted helper, and the form's error line. The field itself never turns red (G07).
 */
import { useEffect } from "react";
import type { ComponentRef, Ref } from "react";
import { AccessibilityInfo, TextInput, View } from "react-native";
import type { TextInputProps } from "react-native";

import { Text } from "./text";

/** Props for `Field`. */
export interface FieldProps extends Omit<TextInputProps, "style" | "className"> {
  readonly label: string;
  /** A muted line under the field, such as what the address is for. */
  readonly helper?: string;
  /** The danger line under the field, such as why the server refused the form. */
  readonly error?: string | null;
  readonly ref?: Ref<ComponentRef<typeof TextInput>>;
}

/** A labeled single-line field with its helper and error line. */
export function Field({ label, helper, error = null, ref, ...props }: FieldProps) {
  // iOS has no live regions: VoiceOver hears a refusal when it appears, and again in the field's
  // label when it lands on the field.
  useEffect(() => {
    if (error !== null) AccessibilityInfo.announceForAccessibility(error);
  }, [error]);

  return (
    <View className="gap-2 pt-4">
      <Text variant="label">{label}</Text>
      <TextInput
        ref={ref}
        accessibilityLabel={error === null ? label : `${label}, ${error}`}
        accessibilityHint={helper}
        className="min-h-row-touch rounded-lg bg-surface p-4 font-sans text-md text-text"
        placeholderTextColorClassName="accent-text-muted"
        selectionColorClassName="accent-accent"
        cursorColorClassName="accent-accent"
        autoCorrect={false}
        maxFontSizeMultiplier={1.6}
        {...props}
      />
      {helper === undefined ? null : (
        <Text variant="secondary" tone="muted">
          {helper}
        </Text>
      )}
      {error === null ? null : (
        <Text
          variant="calloutMedium"
          tone="danger"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {error}
        </Text>
      )}
    </View>
  );
}
