import { Search } from "lucide-react-native";
import { TextInput, View } from "react-native";

import { Icon } from "@/components/ui/icon";

export interface SearchFieldProps {
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder: string;
}

/** A search pill with the native clear button while editing. */
export function SearchField({ value, onChangeText, placeholder }: SearchFieldProps) {
  return (
    <View className="flex-row items-center gap-3 rounded-full bg-surface p-4">
      <Icon icon={Search} size="inline" />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        className="flex-1 font-sans text-md leading-md text-text"
        placeholderTextColorClassName="accent-text-muted"
        selectionColorClassName="accent-accent"
        cursorColorClassName="accent-accent"
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="while-editing"
        maxFontSizeMultiplier={1.6}
      />
    </View>
  );
}
