"use client";

// A curated set of Google Fonts covering the styles other caption-heavy
// editors (CapCut, Opus Clip, etc.) default to — clean sans for general
// captions, bold display faces for hook text, a couple of serif/script
// options for variety. Fetched from Google's CDN on demand — no API key
// needed (the CSS2 endpoint is public for actually using a font; only
// Google's font-*discovery* API requires a key, which this list sidesteps
// entirely by curating names ourselves).
export const GOOGLE_FONTS: string[] = [
  "Inter",
  "Roboto",
  "Poppins",
  "Montserrat",
  "Open Sans",
  "Lato",
  "Nunito",
  "Work Sans",
  "Manrope",
  "DM Sans",
  "Bebas Neue",
  "Anton",
  "Oswald",
  "Archivo Black",
  "Righteous",
  "Playfair Display",
  "Merriweather",
  "Libre Baskerville",
  "Caveat",
  "Pacifico",
  "Permanent Marker",
  "Bangers",
  "Kalam",
  "Fredoka",
  "Baloo 2",
  "Space Grotesk",
  "Sora",
  "Outfit",
  "Plus Jakarta Sans",
  "Barlow Condensed",
  "Fjalla One",
  "Lobster",
  "Dancing Script",
  "Quicksand",
  "Raleway",
  "Rubik",
];

const loaded = new Set<string>();

// Injects a <link> for the given family the first time it's used. Safe to
// call repeatedly — subsequent calls for an already-loaded family are a no-op.
export function loadGoogleFont(family: string): void {
  if (typeof document === "undefined" || loaded.has(family)) return;
  loaded.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;700&display=swap`;
  document.head.appendChild(link);
}
