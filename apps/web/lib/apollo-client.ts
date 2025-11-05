"use client";

import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from "@apollo/client";
import { onError } from "@apollo/client/link/error";
import { setContext } from "@apollo/client/link/context";
import { getSession } from "next-auth/react";
import { env } from "./env";

let apolloClient: ApolloClient<any> | null = null;

const httpLink = new HttpLink({
  uri: env.graphqlUrl,
  credentials: "include"
});

const authLink = setContext(async (_, { headers }) => {
  const session = (await getSession()) as (Record<string, any> & { accessToken?: string }) | null;
  const token = session?.accessToken;
  return {
    headers: {
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  };
});

const errorLink = onError(({ graphQLErrors, networkError }) => {
  if (graphQLErrors) {
    graphQLErrors.forEach((error) => {
      console.error(`[GraphQL error]: ${error.message}`, error);
    });
  }
  if (networkError) {
    console.error("[Network error]", networkError);
  }
});

function createApolloClient() {
  return new ApolloClient({
    link: ApolloLink.from([errorLink, authLink, httpLink]),
    cache: new InMemoryCache(),
    defaultOptions: {
      watchQuery: {
        fetchPolicy: "cache-and-network"
      }
    }
  });
}

export function getApolloClient() {
  if (typeof window === "undefined") {
    return createApolloClient();
  }

  if (!apolloClient) {
    apolloClient = createApolloClient();
  }

  return apolloClient;
}
