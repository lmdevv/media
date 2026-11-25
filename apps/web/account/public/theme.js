// Loaded as a blocking classic script from index.html so the theme lands before first paint; the
// content security policy refuses inline scripts.
try {
  const dark = matchMedia("(prefers-color-scheme: dark)");

  const apply = () => {
    document.documentElement.classList.toggle("dark", dark.matches);

    document.documentElement.style.colorScheme = dark.matches ? "dark" : "light";
  };

  apply();

  dark.addEventListener("change", apply);
} catch {}
