// Applies the saved or system theme before first paint, so dark mode never flashes light. It is a
// file rather than an inline script so the Content-Security-Policy can allow only same-origin
// scripts.
try {
  const saved = localStorage.getItem("music-theme");

  const dark =
    saved === "dark" ||
    ((saved === null || saved === "system") && matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.classList.add(dark ? "dark" : "light");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
} catch {}
