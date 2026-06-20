/**
 * Tailwind configuration for RetroTape.
 *
 * We scan the EJS views and any client-side JS for class names so the
 * compiled stylesheet only contains the utilities we actually use.
 * The retro palette and fonts below are surfaced as Tailwind tokens so
 * they can be referenced with utilities like `text-amber-glow` or
 * `font-display`, while the heavier CRT/VHS effects live in retro.css.
 */
module.exports = {
  content: [
    "./views/**/*.ejs",
    "./public/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        // Deep blacks and dark grays for the chassis.
        chassis: {
          900: "#0a0a0a",
          800: "#121212",
          700: "#1b1b1b",
          600: "#242424",
          500: "#2e2e2e",
        },
        // Glowing amber digital display.
        amber: {
          glow: "#ffb000",
          soft: "#ffd596", // gentler amber for comfortable reading
          dim: "#7a5400",
        },
        // Neon/phosphor green digital display.
        phosphor: {
          glow: "#33ff66",
          soft: "#9bf0b4", // gentler green for labels / body accents
          dim: "#0c5c24",
        },
        // Warm "paper" cream — the cozy reading colour.
        cream: "#efe6d2",
        // The classic "blue screen" of an idle TV / system state.
        bluescreen: "#0000aa",
      },
      fontFamily: {
        // Digital clock style monospaced font for timers/displays.
        digital: ['"VT323"', '"Share Tech Mono"', "monospace"],
        // Heading font: VT323 first (legible, cozy CRT), arcade font as accent.
        display: ['"VT323"', '"Press Start 2P"', "monospace"],
        mono: ['"Share Tech Mono"', "monospace"],
      },
      boxShadow: {
        // Inset "pressed in" look for tactile VCR buttons.
        button: "inset 0 -3px 0 rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.8)",
        "button-active": "inset 0 3px 6px rgba(0,0,0,0.9)",
      },
    },
  },
  plugins: [],
};
