/* IS THIS TEXT A JOB DESCRIPTION, OR IS IT THE APPLICATION FORM? One question, asked in two places.
 *
 * routes/jobExtract.ts asks it inline as `leadRequirementCandidates(jdText).length === 0`, deployed
 * at main fbd4379, and is deliberately NOT refactored to call through here: a guard already live in
 * production is not worth rewriting for a name. This module is that same expression under a name,
 * for lib/packetJdRepair.ts to ask of the rows frozen before that guard shipped - and the home of
 * the calibration below, which is what neither caller carries.
 *
 * Pure on purpose - no database, no network, no model - so the repair can ask a question about a
 * string without pulling a route's dependencies in.
 *
 * THE PREDICATE IS BORROWED, NOT INVENTED. leadRequirementCandidates is what engine/leadAlignment.ts
 * already uses to decide that a frozen description "contains no supported primary ask", and what
 * llm/resumeSpec.ts shows the model as the closed list of things a resume may be ordered against.
 * A private "does this look like a form" heuristic here would be a second definition of what a
 * requirement is, free to disagree with the one every scorer downstream uses. See
 * packetJdStatesNoRequirement in lib/packetJdRepair.ts's header for what is deliberately not tested
 * alongside it, and for the false-refusal class this predicate is known to have.
 */
import { leadRequirementCandidates } from '../engine/leadAlignment';
import type { JdContext } from '../engine/jdMatch';

/**
 * Whether a page states no requirement at all.
 *
 * The two callers MUST ask the same question. A stored-row detector that was stricter than the
 * deployed intake guard would "repair" rows the live route is perfectly happy to create; a looser
 * one would leave behind exactly the rows the guard now refuses.
 *
 * THE DEPLOYED ROUTE SPLITS ITS DIAGNOSIS AND THIS DOES NOT. fbd4379 asks the predicate a second
 * time on the UNCLIPPED text, to tell `job_extract_truncated_past_description` (a description pushed
 * past the 20k cap by something like a three-thousand-option `<select>`) from
 * `job_extract_no_requirements` (a page that never had one). That is a choice of which sentence to
 * log, not of whether to refuse - and a stored packet has no unclipped text left to ask - so the
 * split is not modelled here.
 */
export function statesNoRequirement(jdText: string, context?: JdContext): boolean {
  return leadRequirementCandidates(jdText, context).length === 0;
}
