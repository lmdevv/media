import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

const toasterTheme = (theme: string | undefined): "light" | "dark" | "system" =>
  theme === "light" || theme === "dark" ? theme : "system";

/**
 * Toasts in the Paper style: a dark pill with inverse text and an accent action ("Undo"). Errors
 * carry a danger dot and their message, so they never rely on color alone.
 */
export function Toaster() {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={toasterTheme(theme)}
      position="bottom-center"
      offset={112}
      mobileOffset={{ bottom: 168 }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "flex w-[360px] max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg bg-text px-4 py-3 font-sans text-base/sm text-text-inverse shadow-[0_12px_32px_color-mix(in_oklab,var(--color-text)_24%,transparent)]",
          title: "grow",
          description: "text-sm/xs text-text-inverse/(--opacity-muted)",
          actionButton: "shrink-0 cursor-pointer font-semibold text-accent",
          cancelButton: "shrink-0 cursor-pointer text-text-inverse/(--opacity-muted)",
          icon: "shrink-0 [&_svg]:size-4",
          error: "[&_[data-icon]]:text-danger",
          success: "[&_[data-icon]]:text-success",
        },
      }}
    />
  );
}
