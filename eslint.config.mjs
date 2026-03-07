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
];
