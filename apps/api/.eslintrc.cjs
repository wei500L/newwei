module.exports = {
  root: true,
  extends: [require.resolve("@modular/config/eslint/nest")],
  parserOptions: {
    project: [__dirname + "/tsconfig.json"],
    tsconfigRootDir: __dirname
  },
  ignorePatterns: ["dist", "node_modules"],
  rules: {
    "@typescript-eslint/explicit-function-return-type": "off"
  }
};
