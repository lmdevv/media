/** The 34/40 hero line Paper puts above a settings form, such as "Give your agent / a way in." */
import { Text } from "@/components/ui/text";

/** Paper's top padding over each hero: 24 (F10), 32 (F05), 48 (F11, F23, F28). */
const TOP = { compact: "pt-6", regular: "pt-8", loose: "pt-12" } as const;

/** Props for `Headline`. */
export interface HeadlineProps {
  /** Paper breaks the line by hand; pass `\n` where it does. */
  readonly children: string;
  readonly top: keyof typeof TOP;
}

/** A large settings headline. */
export function Headline({ children, top }: HeadlineProps) {
  return (
    <Text variant="hero" accessibilityRole="header" className={TOP[top]}>
      {children}
    </Text>
  );
}
