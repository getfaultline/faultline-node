// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Clean-architecture dependency rule, enforced with `no-restricted-imports`:
 *
 *   domain  <-  application  <-  infrastructure / integrations  <-  index
 *
 * Inner layers may never import outer layers. infrastructure and integrations are
 * siblings on the same ring and may not import each other either: they only meet in
 * the composition root (src/index.ts).
 */
const layer = (name) => ({
  regex: `(^|/)${name}(/|$)`,
  message: `Clean-architecture violation: this layer must not import from "${name}".`,
});
const indexImport = {
  regex: "^\\.\\.?/(\\.\\./)*index(\\.js)?$",
  message:
    "Clean-architecture violation: the composition root (src/index.ts) must not be imported by inner layers.",
};
const nodeBuiltins = {
  regex: "^node:",
  message: "The domain layer is pure TypeScript: no Node built-ins.",
};

const restrict = (...patterns) => ({
  "no-restricted-imports": ["error", { patterns }],
});

export default tseslint.config(
  { ignores: ["dist", "coverage", "node_modules", "examples/**/node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  // ---- layer boundaries ----
  {
    files: ["src/domain/**/*.ts"],
    rules: restrict(
      layer("application"),
      layer("infrastructure"),
      layer("integrations"),
      indexImport,
      nodeBuiltins,
    ),
  },
  {
    files: ["src/application/**/*.ts"],
    rules: restrict(layer("infrastructure"), layer("integrations"), indexImport),
  },
  {
    files: ["src/infrastructure/**/*.ts"],
    rules: restrict(layer("integrations"), indexImport),
  },
  {
    files: ["src/integrations/**/*.ts"],
    rules: restrict(layer("infrastructure"), indexImport),
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  prettier,
);
