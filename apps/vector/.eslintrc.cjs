module.exports = {
  root: true,
  extends: [require.resolve('@modular/config/eslint/nest')],
  parserOptions: {
    project: [__dirname + '/tsconfig.json'],
    tsconfigRootDir: __dirname
  },
  settings: {
    'import/resolver': {
      typescript: {
        project: [__dirname + '/tsconfig.json'],
        alwaysTryTypes: true
      }
    }
  },
  ignorePatterns: ['dist', 'node_modules'],
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off'
  }
};

