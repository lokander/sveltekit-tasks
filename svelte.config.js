import { mdsvex, escapeSvelte } from "mdsvex";
import adapter from "@sveltejs/adapter-auto";
import { createHighlighter } from "shiki";

const highlighter = await createHighlighter({
  themes: ["github-dark"],
  langs: ["typescript", "javascript", "svelte", "css", "bash", "json"],
});

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
    // If your environment is not supported, or you settled on a specific environment, switch out the adapter.
    // See https://svelte.dev/docs/kit/adapters for more information about adapters.
    adapter: adapter(),
    experimental: {
      remoteFunctions: true,
    },
  },
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
  compilerOptions: {
    runes: true,
    experimental: {
      async: true,
    },
  },
};

export default config;
