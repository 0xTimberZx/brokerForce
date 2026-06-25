/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Design tokens (colors, type scale) intentionally left default for now —
      // real visual design is a frontend-design task tied to actual spec UI work,
      // not something to invent ahead of building 001 Dashboard.
    },
  },
  plugins: [],
};
