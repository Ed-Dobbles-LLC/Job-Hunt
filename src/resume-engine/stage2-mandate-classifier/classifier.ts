/**
 * Stage 2: Mandate Classifier
 *
 * Wraps the existing mandate classifier from the tools directory,
 * producing a MandateProfile from the job description text.
 *
 * Type: LLM-optional (currently deterministic keyword matching,
 * with optional LLM enhancement in the future)
 */

import {
  classifyMandate as existingClassifyMandate,
  type MandateProfile,
} from "../../mastra/tools/mandateClassifier";
import type { JDRequirements } from "../../mastra/tools/extractJDRequirementsTool";

export { type MandateProfile } from "../../mastra/tools/mandateClassifier";

export interface ClassifyMandateInput {
  jdText: string;
  title: string;
  requirements?: JDRequirements;
}

export interface ClassifyMandateResult {
  mandate: MandateProfile;
  duration_ms: number;
}

/**
 * Classify a job description into mandate archetype weights + tone profile.
 * Currently delegates to the existing deterministic classifier.
 */
export function classifyJobMandate(input: ClassifyMandateInput): ClassifyMandateResult {
  const start = Date.now();
  const mandate = existingClassifyMandate(input.jdText, input.title, input.requirements);
  return {
    mandate,
    duration_ms: Date.now() - start,
  };
}
