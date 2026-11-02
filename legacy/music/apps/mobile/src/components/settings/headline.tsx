import { Text } from "@/components/ui/text";

const TOP = { compact: "pt-6", regular: "pt-8", loose: "pt-12" } as const;

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
