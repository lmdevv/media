import { useEffect } from "react";
import type { ComponentRef, Ref } from "react";
import { AccessibilityInfo, TextInput, View } from "react-native";
import type { TextInputProps } from "react-native";

import { Text } from "./text";

/** Props for `TextField`. */
export interface TextFieldProps extends Omit<TextInputProps, "style"> {
  readonly label: string;
  /** A short line in the danger color, such as `Wrong email or password`. */
  readonly error?: string | null;
  readonly className?: string;
  readonly ref?: Ref<ComponentRef<typeof TextInput>>;
}

/** A labeled single-line field. */
export function TextField({ label, error, className, ref, ...props }: TextFieldProps) {
  const invalid = error !== undefined && error !== null && error !== "";

  // iOS has no live regions or invalid state: VoiceOver hears a refusal when it appears and again
  // in the field's label when it lands on the field.
  useEffect(() => {
    if (invalid) AccessibilityInfo.announceForAccessibility(error);
  }, [invalid, error]);

  return (
    <View className={`w-full gap-2 ${className ?? ""}`}>
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <TextInput
        ref={ref}
        accessibilityLabel={invalid ? `${label}, ${error}` : label}
        className={`h-14 rounded-control bg-surface px-4 font-sans text-ios-17 text-text ${
          invalid ? "border border-danger" : ""
        }`}
        placeholderTextColorClassName="accent-text-muted"
        selectionColorClassName="accent-accent"
        cursorColorClassName="accent-accent"
        autoCorrect={false}
        {...props}
      />
      {invalid ? (
        <Text
          variant="meta"
          tone="danger"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
