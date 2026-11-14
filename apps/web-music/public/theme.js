try {
  const saved = localStorage.getItem("music-theme");

  const dark =
    saved === "dark" ||
    ((saved === null || saved === "system") && matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.classList.add(dark ? "dark" : "light");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
} catch {}
