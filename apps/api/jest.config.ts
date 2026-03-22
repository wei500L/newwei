import type { Config } from "jest";

const config: Config = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "./",
  testRegex: ".*\\.spec\\.ts$",
  modulePathIgnorePatterns: ["<rootDir>/dist/"],
  transform: {
    "^.+\\.(t|j)s$": ["ts-jest", { tsconfig: "./tsconfig.spec.json" }]
  },
  moduleNameMapper: {
    "^@modular/utils$": "<rootDir>/../../packages/utils/src/index.ts",
    "^@modular/config$": "<rootDir>/../../packages/config/src/index.ts",
    "^@modular/db$": "<rootDir>/../../packages/db/src/index.ts",
    "^@modular/mongo$": "<rootDir>/../../packages/mongo/src/index.ts",
    "^@modular/vector-client$": "<rootDir>/../../packages/vector-client/src/index.ts"
  },
  collectCoverageFrom: ["src/**/*.(t|j)s"],
  coverageDirectory: "../coverage",
  testEnvironment: "node"
};

export default config;
