module.exports = {
  root: false,
  ignorePatterns: ["**/*.d.ts"],
  env: {
    es2022: true,
    node: true
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module"
  },
  plugins: ["@typescript-eslint", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/stylistic",
    "plugin:import/recommended",
    "plugin:import/typescript",
    "prettier"
  ],
  settings: {
    "import/resolver": {
      typescript: {
        project: ["./tsconfig.json"],
        alwaysTryTypes: true
      }
    }
  },
  rules: {
    "@typescript-eslint/explicit-module-boundary-types": "off",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/consistent-type-imports": ["error", { "prefer": "type-imports" }],
    "no-restricted-syntax": [
      "error",
      {
        selector: "TSAsExpression[expression.type='TSAsExpression']",
        message: "Do not use `as unknown as`. Use a type guard, Zod parse, or a typed helper."
      }
    ],
    "import/order": [
      "error",
      {
        "groups": [["builtin", "external"], "internal", "parent", "sibling", "index"],
        "newlines-between": "always",
        "alphabetize": { "order": "asc", "caseInsensitive": true }
      }
    ]
  },
  overrides: [
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/__tests__/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-syntax": "off"
      }
    }
  ]
};
