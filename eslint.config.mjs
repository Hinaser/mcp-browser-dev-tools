import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      ".codex-reviews/**",
      ".husky/_/**",
      ".npm-pack-cache/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    ignores: ["src/page-script.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Runs in the page, where only browser globals exist.
    files: ["src/page-script.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.browser,
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
];
