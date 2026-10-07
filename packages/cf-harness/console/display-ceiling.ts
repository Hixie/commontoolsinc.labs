/**
 * What the console may show its owner (CFC §8.10.6): a value's label has to
 * fit the console's display ceiling before the value reaches a page.
 *
 * The ceiling is the default one a display has when no authored policy covers
 * it, the same one the shell gives its own display. Its audience is the
 * console's owner, the identity the console's fabric session signs as, which
 * is the person viewing it only while the console is served to that one
 * person. The ceiling admits the atoms naming exactly the owner, and the whole
 * family of prompt caveats (SC-54, proposed §8.10.6, whose ruling on the
 * material-risk kinds is still open as 13-11 decision #33). A prompt caveat
 * says not to trust content as instructions to a model, and a display shows
 * the content to a person, so admitting the caveat does not discharge it. A
 * label naming anyone or anything else does not fit, and neither does a label
 * that could not be read. The fit is atom by atom, without the exchange rules
 * that would admit a space the owner reads, so it is never wider than the
 * shell's.
 */

import { cfcAtom } from "@commonfabric/api/cfc";
import type { DID } from "@commonfabric/identity";
import {
  canRenderLabelUnderPolicy,
  rootRenderPolicyFor,
} from "@commonfabric/html/worker";
import {
  type IFCLabel,
  PROMPT_CAVEAT_FAMILY_KINDS,
} from "@commonfabric/runner/cfc";

/** Whether a value with a label may be shown on the console. */
export type ConsoleDisplayFit = (label: IFCLabel) => boolean;

/**
 * The fit of `label` under the ceiling `configured` describes. A label too
 * malformed to fit at all does not fit.
 */
const fitsCeiling = (configured: object) => {
  const policy = rootRenderPolicyFor(configured);
  return (label: IFCLabel): boolean => {
    if (policy === undefined) return false;
    try {
      return canRenderLabelUnderPolicy(
        label.confidentiality ?? [],
        label.integrity ?? [],
        () => [],
        policy,
        {},
      );
    } catch {
      return false;
    }
  };
};

/**
 * The fit of a console whose owner it does not know: only a label naming no
 * one, which any display may show.
 */
export const publicConsoleDisplay: ConsoleDisplayFit = fitsCeiling({});

/** The fit of the console `owner` sees. */
export const ownerConsoleDisplay = (owner: DID): ConsoleDisplayFit =>
  fitsCeiling({
    atoms: [cfcAtom.user(owner), cfcAtom.personalSpace(owner), owner],
    caveatKinds: [...PROMPT_CAVEAT_FAMILY_KINDS],
  });
