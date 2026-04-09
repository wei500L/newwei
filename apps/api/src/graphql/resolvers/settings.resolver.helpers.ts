import type { NewsEventSourcePolicyInput } from "../../modules/news-events/news-event-source-policy.service";
import type {
  UpdateNewsEventSourcePolicyInput,
  UpdateNewsEventSourcePolicyPresetInput,
} from "../dto/settings.input";

type SourcePolicyMutationInput = Pick<
  UpdateNewsEventSourcePolicyInput,
  | "authoritativeDomains"
  | "authoritativeLabels"
  | "blogDomains"
  | "blogLabels"
  | "categoryAuthority"
> &
  Pick<
    UpdateNewsEventSourcePolicyPresetInput,
    | "authoritativeDomains"
    | "authoritativeLabels"
    | "blogDomains"
    | "blogLabels"
    | "categoryAuthority"
  >;

export function toNewsEventSourcePolicyInput(
  input: SourcePolicyMutationInput,
): NewsEventSourcePolicyInput {
  const baseInput: NewsEventSourcePolicyInput = {
    authoritativeDomains: input.authoritativeDomains,
    authoritativeLabels: input.authoritativeLabels,
    blogDomains: input.blogDomains,
    blogLabels: input.blogLabels,
  };

  if (input.categoryAuthority === undefined) {
    return baseInput;
  }

  return {
    ...baseInput,
    categoryAuthority: (input.categoryAuthority ?? []).map((entry) => ({
      categoryPrefix: entry.categoryPrefix,
      authoritativeBoost: entry.authoritativeBoost,
      blogPenalty: entry.blogPenalty,
      unknownPenalty: entry.unknownPenalty,
      minConfidenceFloor: entry.minConfidenceFloor ?? 0,
      mismatchPenalty: entry.mismatchPenalty ?? 0,
      domainBoosts: (entry.domainBoosts ?? []).map((boost) => ({
        domain: boost.domain,
        delta: boost.delta,
      })),
    })),
  };
}
