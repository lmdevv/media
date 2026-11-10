const gradient = (stops: ReadonlyArray<string>, angle = 135): string => {
  const radians = ((angle - 90) * Math.PI) / 180;
  const x = Math.cos(radians) / 2;
  const y = Math.sin(radians) / 2;

  const offsets = stops
    .map(
      (color, index) =>
        `<stop offset="${index / Math.max(1, stops.length - 1)}" stop-color="${color}"/>`,
    )
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" preserveAspectRatio="none"><defs><linearGradient id="g" x1="${0.5 - x}" y1="${0.5 - y}" x2="${0.5 + x}" y2="${0.5 + y}">${offsets}</linearGradient></defs><rect width="16" height="16" fill="url(#g)"/></svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

/** Sample artwork keyed by title. */
export const ART = {
  dune: gradient(["#c3a07c", "#8f735a", "#5f4a37"]),
  severance: gradient(["#4b6584", "#1d2a3c"]),
  severancePoster: gradient(["#4b6584", "#141d2b"], 160),
  bear: gradient(["#8e3b46", "#3b1a1f"]),
  shogun: gradient(["#6f7d4c", "#2f3521"]),
  pastLives: gradient(["#b8899c", "#5b3f50"]),
  arrival: gradient(["#9ea3aa", "#4b5057"]),
  bladeRunner: gradient(["#c06a3e", "#4a2216"]),
  sicario: gradient(["#9b7a4b", "#3f2f1c"]),
  perfectDays: gradient(["#76875a", "#2f3a23"], 160),
  andor: gradient(["#55606c", "#1f252d"], 160),
  holdovers: gradient(["#c19a76", "#5d4635"], 160),
  poorThings: gradient(["#7d2f3b", "#2b1317"], 160),
  alex: gradient(["#e3a35f", "#c45a2c"]),
  kids: gradient(["#f6d66c", "#ef9659", "#e86fa1"]),
  maya: gradient(["#5c8ad6", "#2b479e"]),
  sam: gradient(["#77bf86", "#3b7f50"]),
} as const;
