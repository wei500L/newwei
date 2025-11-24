import type { Config } from "jest";

const config: Config = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "./",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": ["ts-jest", { tsconfig: "./tsconfig.spec.json" }]
  },
  moduleNameMapper: {
    "^@modular/utils$": "<rootDir>/../../packages/utils/src",
    "^@modular/config$": "<rootDir>/../../packages/config/src",
    "^@modular/db$": "<rootDir>/../../packages/db/src",
    "^@modular/mongo$": "<rootDir>/../../packages/mongo/src"
  },
  collectCoverageFrom: ["src/**/*.(t|j)s"],
  coverageDirectory: "../coverage",
  testEnvironment: "node"
};

export default config;
