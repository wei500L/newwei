const schemaUrl = process.env.GRAPHQL_SCHEMA_URL || '../api/schema.gql';

/** @type {import('@graphql-codegen/cli').CodegenConfig} */
module.exports = {
  schema: schemaUrl,
  documents: 'graphql/**/*.graphql',
  generates: {
    'graphql/generated.ts': {
      plugins: ['typescript', 'typescript-operations', 'typescript-react-apollo'],
      config: {
        withHooks: true,
        reactApolloVersion: 3,
        exposeQueryKeys: true,
      },
    },
  },
};

