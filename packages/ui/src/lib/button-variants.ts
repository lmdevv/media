import { cva } from "class-variance-authority";

/**
 * Class names for the buttons, for elements that only look like a button (such as a router
 * link). Prefer {@link Button}.
 */
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-control font-sans whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-(--opacity-disabled) [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /** Netflix red, for the one main action: Play, Continue, Sign in. */
        primary:
          "bg-accent font-bold text-on-accent hover:bg-accent-pressed active:bg-accent-pressed",
        /** A white fill over dark media, such as Next episode and Back to details on the player. */
        inverse: "on-media bg-text font-bold text-dark-bg hover:bg-text/85",
        /** Translucent gray over artwork, such as More info on the hero. */
        secondary: "on-media bg-media-secondary font-semibold hover:bg-media-secondary/50",
        /** A soft fill for secondary actions on surfaces, such as Copy invite link. */
        subtle: "bg-text/10 font-semibold text-text hover:bg-text/15",
        /** Hairline outline, such as Cancel and End room. */
        ghost: "border border-hairline font-semibold text-text hover:bg-text/6",
        /** A raised fill with a hairline, for toolbar and row actions such as Scan all and Fix match. */
        raised: "border border-hairline bg-surface-raised font-semibold text-text hover:bg-text/10",
        /** Outlined danger color for destructive actions, placed beside a plain Cancel. */
        destructive: "border border-danger font-semibold text-danger hover:bg-danger/10",
        /** Frosted white fill over artwork on phones, such as My List on the hero card. */
        glass: "on-media bg-text/18 font-semibold hover:bg-text/25",
        /** A round outlined icon over artwork, such as Add to My List. */
        icon: "on-media rounded-pill border-control border-text/50 hover:border-text hover:bg-text/10",
      },
      size: {
        /** A table row action, such as Fix match or Revoke. */
        row: "h-7 px-2.5 text-label/label [&_svg]:size-3.5",
        /** A toolbar action beside a page title, such as Scan all or Add library. */
        xs: "h-8 gap-1.5 px-3 text-label/label [&_svg]:size-3.5",
        /** A dialog action, such as Cancel and Create key. */
        dialog: "h-10 px-3.5 text-label/caption [&_svg]:size-4",
        sm: "h-9 px-3.5 text-label/4 [&_svg]:size-4",
        md: "h-11 px-5 text-body/4.5 [&_svg]:size-4.5",
        lg: "h-12 px-6 text-body/4.5 [&_svg]:size-4.5",
        icon: "size-11 [&_svg]:size-4.5",
        /** The full-width phone pill, such as Resume on the hero card. */
        pill: "h-12 rounded-pill px-6 text-button/5 [&_svg]:size-4.5",
      },
    },
    compoundVariants: [
      { variant: "primary", size: "dialog", className: "px-5 text-body/label" },
      { variant: "primary", size: "md", className: "pr-5.5 pl-4.5 [&_svg]:size-4" },
      { variant: "primary", size: "lg", className: "pr-7.5 pl-6 [&_svg]:size-4" },
      { variant: "secondary", size: "lg", className: "pr-7 pl-6" },
    ],
    defaultVariants: { variant: "primary", size: "md" },
  },
);
