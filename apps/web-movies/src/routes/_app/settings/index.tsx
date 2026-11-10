import { buttonVariants } from "@media/ui/lib/button-variants";
import { PageHeader } from "@media/ui/components/page-header";
import { RadioGroup, RadioItem } from "@media/ui/components/radio-group";
import { createFileRoute } from "@tanstack/react-router";
import { useTheme } from "next-themes";

import { ACCOUNT_SETTINGS } from "@/lib/account-links";

export const Route = createFileRoute("/_app/settings/")({
  head: () => ({ meta: [{ title: "Preferences · [movies]" }] }),
  component: PreferencesPage,
});

const THEMES = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Match system" },
] as const;

type ThemeChoice = (typeof THEMES)[number]["value"];

const themeChoice = (theme: string | undefined): ThemeChoice =>
  THEMES.find((choice) => choice.value === theme)?.value ?? "system";

/**
 * This browser's preferences: the theme, kept in this browser as before. Subtitles, audio
 * language, autoplay, and the rest of the core's settings follow the person to every device and
 * are set in the account client's settings.
 */
function PreferencesPage() {
  const { theme, setTheme } = useTheme();

  return (
    <>
      <PageHeader title="Preferences" />
      <section aria-labelledby="theme" className="flex flex-col gap-3">
        <h2 id="theme" className="font-sans text-body/body font-semibold text-text">
          Theme
        </h2>
        <RadioGroup
          value={themeChoice(theme)}
          onValueChange={(value) => setTheme(themeChoice(String(value)))}
          className="gap-3"
        >
          {THEMES.map((choice) => (
            <label
              key={choice.value}
              className="flex cursor-pointer items-center gap-3 font-sans text-body/body text-text"
            >
              <RadioItem value={choice.value} />
              {choice.label}
            </label>
          ))}
        </RadioGroup>
      </section>
      <section aria-labelledby="account" className="flex flex-col items-start gap-3">
        <h2 id="account" className="font-sans text-body/body font-semibold text-text">
          Account
        </h2>
        <a href={ACCOUNT_SETTINGS} className={buttonVariants({ variant: "subtle", size: "sm" })}>
          Account settings
        </a>
      </section>
    </>
  );
}
