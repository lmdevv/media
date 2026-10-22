/** The danger line under a form or a list of actions when the server refused the last one. */
import { useEffect } from "react";
import { AccessibilityInfo } from "react-native";

import { Text } from "@/components/ui/text";

/** Shows `message`, and tells VoiceOver once it appears; nothing when there is no failure. */
export function Failure({ message }: { readonly message: string | null }) {
  useEffect(() => {
    if (message !== null) AccessibilityInfo.announceForAccessibility(message);
  }, [message]);

  if (message === null) return null;

  return (
    <Text variant="calloutMedium" tone="danger" className="pt-2">
      {message}
    </Text>
  );
}
