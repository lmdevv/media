import { Text } from "@/components/ui/text";

const TOP = { compact: "pt-6", regular: "pt-8", loose: "pt-12" } as const;

export interface HeadlineProps {
  /** The line breaks by hand; pass `\n` where it should break. */
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
