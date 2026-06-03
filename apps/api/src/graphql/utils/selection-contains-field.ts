import type { GraphQLResolveInfo, SelectionNode } from "graphql";

export function selectionContainsField(
  selections: readonly SelectionNode[] | undefined,
  fieldName: string,
  fragments?: GraphQLResolveInfo["fragments"],
  visitedFragmentNames = new Set<string>(),
): boolean {
  if (!selections || selections.length === 0) {
    return false;
  }

  for (const selection of selections) {
    if (selection.kind === "Field") {
      if (selection.name.value === fieldName) {
        return true;
      }
      if (
        selection.selectionSet &&
        selectionContainsField(
          selection.selectionSet.selections,
          fieldName,
          fragments,
          visitedFragmentNames,
        )
      ) {
        return true;
      }
      continue;
    }

    if (selection.kind === "InlineFragment") {
      if (
        selectionContainsField(
          selection.selectionSet.selections,
          fieldName,
          fragments,
          visitedFragmentNames,
        )
      ) {
        return true;
      }
      continue;
    }

    if (selection.kind === "FragmentSpread") {
      const fragmentName = selection.name.value;
      if (visitedFragmentNames.has(fragmentName)) {
        continue;
      }
      const fragment = fragments?.[fragmentName];
      if (!fragment) {
        continue;
      }
      visitedFragmentNames.add(fragmentName);
      if (
        selectionContainsField(
          fragment.selectionSet.selections,
          fieldName,
          fragments,
          visitedFragmentNames,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}
