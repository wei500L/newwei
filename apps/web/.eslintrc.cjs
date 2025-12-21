module.exports = {
  root: true,
  extends: ["next", "next/core-web-vitals", require.resolve("@modular/config/eslint/react")],
  parserOptions: {
    project: [__dirname + "/tsconfig.json"],
    tsconfigRootDir: __dirname
  },
  settings: {
    next: {
      rootDir: [__dirname]
    },
    "import/core-modules": ["i18next", "react-i18next"],
    "import/resolver": {
      typescript: {
        project: [__dirname + "/tsconfig.json"],
        alwaysTryTypes: true
      }
    }
  }
};
