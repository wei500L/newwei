module.exports = {
  root: true,
  extends: [
    "next",
    "next/core-web-vitals",
    require.resolve("@modular/config/eslint/react"),
  ],
  ignorePatterns: ["graphql/generated.ts"],
  parserOptions: {
    project: [__dirname + "/tsconfig.eslint.json"],
    tsconfigRootDir: __dirname,
  },
  settings: {
    next: {
      rootDir: [__dirname],
    },
    "import/core-modules": ["i18next", "react-i18next", "server-only"],
    "import/resolver": {
      typescript: {
        project: [__dirname + "/tsconfig.eslint.json"],
        alwaysTryTypes: true,
      },
    },
  },
  rules: {
    // @gev/* 由 webpack 别名 + tsconfig 的宽松声明（types/gev.d.ts）解析，
    // ESLint 的 import 解析器看不到这个别名，这里显式放行。
    "import/no-unresolved": ["error", { ignore: ["^@gev/"] }],
  },
  overrides: [
    {
      files: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "test/**/*.ts",
        "test/**/*.tsx",
        "vitest.config.ts",
      ],
      rules: {
        "import/no-extraneous-dependencies": "off",
        "no-restricted-syntax": "off",
      },
    },
  ],
};
