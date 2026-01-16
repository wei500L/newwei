const path = require('node:path');

const defaultSchemaPath = path.resolve(__dirname, '../api/schema.gql');
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
