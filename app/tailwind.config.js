import { colors, fonts } from "./src/theme/tokens.ts";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors,
      fontFamily: {
        sans: [...fonts.sans],
        display: [...fonts.display],
        mono: [...fonts.mono],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        panel: "inset 0 1px 0 rgba(212,155,126,0.07), 0 1px 0 rgba(0,0,0,0.45)",
        lift: "0 18px 50px -20px rgba(0,0,0,0.85), inset 0 1px 0 rgba(212,155,126,0.08)",
        glow: "0 0 0 1px rgba(229,169,103,0.35), 0 8px 30px -10px rgba(229,169,103,0.45)",
      },
      keyframes: {
        marquee: { from: { transform: "translateX(0)" }, to: { transform: "translateX(-50%)" } },
        sheen: { from: { backgroundPosition: "-200% 0" }, to: { backgroundPosition: "200% 0" } },
        pulseRing: { "0%": { transform: "scale(0.9)", opacity: "0.7" }, "100%": { transform: "scale(1.6)", opacity: "0" } },
        flash: { "0%": { backgroundColor: "rgba(229,169,103,0.18)" }, "100%": { backgroundColor: "transparent" } },
      },
      animation: {
        marquee: "marquee 60s linear infinite",
        sheen: "sheen 3.5s linear infinite",
        "pulse-ring": "pulseRing 1.6s ease-out infinite",
        flash: "flash 1.2s ease-out",
      },
    },
  },
  plugins: [],
};
