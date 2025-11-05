const base = require("./base");

module.exports = {
  ...base,
  env: {
    ...base.env
  },
  parserOptions: {
    ...base.parserOptions,
    project: ["./tsconfig.json"],
    tsconfigRootDir: __dirname
  },
  rules: {
    ...base.rules,
    "@typescript-eslint/no-floating-promises": "error"
  }
};
