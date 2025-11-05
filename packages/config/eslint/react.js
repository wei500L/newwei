const base = require("./base");

module.exports = {
  ...base,
  env: {
    ...base.env,
    browser: true
  },
  plugins: [...new Set([...(base.plugins || []), "react", "react-hooks"])],
  extends: [...(base.extends || []), "plugin:react/recommended", "plugin:react-hooks/recommended"],
  settings: {
    ...(base.settings || {}),
    react: {
      version: "detect"
    }
  },
  rules: {
    ...base.rules,
    "react/react-in-jsx-scope": "off"
  }
};
