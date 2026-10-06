import { mdsvex, escapeSvelte } from "mdsvex";
import adapter from "@sveltejs/adapter-auto";
import { createHighlighter } from "shiki";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { sveltekit } from "@sveltejs/kit/vite";

const highlighter = await createHighlighter({
  themes: ["github-dark"],
  langs: ["typescript", "javascript", "svelte", "css", "bash", "json"],
});

export default defineConfig({
  server: { fs: { allow: ["README.md"] } },
  plugins: [
    tailwindcss(),
    sveltekit({
      preprocess: [
        mdsvex({
          extensions: [".svx", ".md"],
          highlight: {
            highlighter: (code, lang) => {
              const html = escapeSvelte(
                highlighter.codeToHtml(code, { lang: lang || "text", theme: "github-dark" }),
              );

              return `{@html \`${html}\`}`;
            },
          },
        }),
      ],
      extensions: [".svelte", ".svx", ".md"],
      compilerOptions: { runes: true, experimental: { async: true } },
      // adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
      // If your environment is not supported, or you settled on a specific environment, switch out the adapter.
      // See https://svelte.dev/docs/kit/adapters for more information about adapters.
      adapter: adapter(),
      experimental: { remoteFunctions: true },
    }),
  ],
  test: {
    expect: { requireAssertions: true },
    projects: [
      {
        extends: "./vite.config.ts",
        test: {
          name: "client",
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: "chromium", headless: true }],
          },
          include: ["src/**/*.svelte.{test,spec}.{js,ts}"],
          exclude: ["src/lib/server/**"],
        },
      },

      {
        extends: "./vite.config.ts",
        test: {
          name: "server",
          environment: "node",
          include: ["src/**/*.{test,spec}.{js,ts}"],
          exclude: ["src/**/*.svelte.{test,spec}.{js,ts}"],
        },
      },
    ],
  },
});
