import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Helvetica Neue",
          "system-ui",
          "sans-serif",
        ],
      },
      colors: {
        sidebar: {
          bg: "#f3f4f6",
          fg: "#111827",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
