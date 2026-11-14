import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Flat config (ESLint 9+, C13): browser TypeScript, strict tsc already
// covers the type-level rules — this catches the lint-level ones.
export default tseslint.config(
  { ignores: ["dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // The `_` prefix marks intentionally unused parameters (test stubs
      // keep a call signature while ignoring the argument).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
