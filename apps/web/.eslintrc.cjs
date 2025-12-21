module.exports = {
  root: true,
  extends: ["next", "next/core-web-vitals", require.resolve("@modular/config/eslint/react")],
  ignorePatterns: ["graphql/generated.ts"],
  parserOptions: {
    project: [__dirname + "/tsconfig.eslint.json"],
    tsconfigRootDir: __dirname
  },
  settings: {
    next: {
      rootDir: [__dirname]
    },
    "import/core-modules": ["i18next", "react-i18next", "server-only"],
    "import/resolver": {
      typescript: {
        project: [__dirname + "/tsconfig.eslint.json"],
        alwaysTryTypes: true
      }
    }
  }
};
