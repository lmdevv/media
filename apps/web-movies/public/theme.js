// The saved theme (dark by default) before first paint, so the page never flashes light. Loaded as
// a blocking classic script from index.html; the content security policy refuses inline scripts.
try {
  const saved = localStorage.getItem("movies-theme") ?? "dark";

  const dark =
    saved === "dark" || (saved === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.classList.add(dark ? "dark" : "light");

  document.documentElement.style.colorScheme = dark ? "dark" : "light";
} catch {}
