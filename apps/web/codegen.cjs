const path = require('node:path');

// The GraphQL SDL is owned by the Go runtime (apps/api-go embeds and serves it).
// During the Node retirement transition the CI job "Contract copies in sync"
// still asserts this file is byte-identical to the Nest generator output.
const defaultSchemaPath = path.resolve(__dirname, '../api-go/internal/graphqlread/schema/schema.gql');
const schemaUrl = process.env.GRAPHQL_SCHEMA_URL || defaultSchemaPath;

/** @type {import('@graphql-codegen/cli').CodegenConfig} */
module.exports = {
  schema: schemaUrl,
  documents: path.resolve(__dirname, 'graphql/**/*.graphql'),
  generates: {
    [path.resolve(__dirname, 'graphql/generated.ts')]: {
      plugins: ['typescript', 'typescript-operations', 'typescript-react-apollo'],
      config: {
        withHooks: true,
        reactApolloVersion: 3,
        exposeQueryKeys: true,
      },
    },
  },
};
