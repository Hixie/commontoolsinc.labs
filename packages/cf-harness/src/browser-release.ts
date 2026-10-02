/**
 * Release decisions for the browser sinks: where something an agent sends to
 * a page may go — an address it opens, a value it enters, a click, a key —
 * decided from the CFC label of what it sends, never from what the agent says
 * about it, and never by asking the owner.
 *
 * What an operation sends is the payload: whatever the run's model context
 * holds (the agent chose the address, the value and the target with all of it
 * in view), the label of each handle the operation resolves, and everything
 * already sent into the session, which every navigation of the session takes
 * with it. A payload's confidentiality label is a conjunction of clauses, and
 * the payload may reach an origin only when every clause is released to it by
 * one of these rules:
 *
 * 1. A clause of the public web — an `Origin` atom, or a prompt caveat whose
 *    source is a page a browser observed — is released to every origin of the
 *    open web.
 * 2. An owner-view clause, `User(owner) ∨ Service(did:web:<host>)`, is
 *    released to the origin it names: what an origin showed the owner may go
 *    back to that origin.
 * 3. The label of a handle the owner gave destinations before the run is
 *    released to those destinations, for that handle's value alone.
 *
 * Every other clause — the owner's data from their space, another person's —
 * is released to no page at all.
 */

import {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  cfcAtom,
} from "@commonfabric/api/cfc";
import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  type CfcConfClause,
  type CfcEnforcementMode,
  clauseAlternatives,
  type IFCLabel,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  BROWSER_RELEASE_PUBLIC_WEB,
  type BrowserReleaseCovers,
  browserReleaseCovers,
  isLocalHostname,
} from "./contracts/browser-host.ts";
import type { HarnessReleaseDecision } from "./contracts/policy-refusal.ts";

/** One part of a payload: a label, and where else that part alone may go. */
export interface BrowserReleasePart {
  label: IFCLabel | undefined;

  /**
   * Origins the owner set as destinations for this part before the run,
   * which rule 3 releases its label to.
   */
  releasedTo?: readonly string[];
}

/** The prompt caveats rule 1 releases. */
const PROMPT_CAVEAT_KINDS: ReadonlySet<string> = new Set([
  CFC_CONCEPT_KIND.PromptInfluence,
  CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
  CFC_CONCEPT_KIND.PromptInjectionRiskIngressScreened,
  CFC_CONCEPT_KIND.PromptInjectionRiskValueScreened,
]);

/** The resource classes that name what a browser observed. */
const BROWSER_OBSERVATION_CLASSES: ReadonlySet<string> = new Set([
  "BrowserObservation",
  "WebPage",
]);

/**
 * The `https` origin a `did:web` DID names, or `undefined` when `did` is
 * not one, names a path, or names this device or its network.
 */
const didWebOrigin = (did: string): string | undefined => {
  const match = /^did:web:([^:]+)$/.exec(did);
  if (match === null) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(`https://${decodeURIComponent(match[1])}`);
  } catch {
    return undefined;
  }
  return url.host === decodeURIComponent(match[1]).toLowerCase() &&
      !isLocalHostname(url.hostname)
    ? url.origin
    : undefined;
};

/** The `did:web` DID naming `origin`'s host and port. */
const didWebOf = (origin: string): string =>
  `did:web:${encodeURIComponent(new URL(origin).host)}`;

/**
 * The owner-view clause for what `origin` shows `owner`: readable by the
 * owner, and by the origin itself.
 */
export const browserOwnerViewClause = (
  owner: string,
  origin: string,
): CfcConfClause => ({
  anyOf: [cfcAtom.user(owner), cfcAtom.service(didWebOf(origin))],
});

const field = (atom: CfcAtom, name: string): unknown =>
  isObjectNotArray(atom) ? (atom as Record<string, unknown>)[name] : undefined;

/** Where the rules release one atom of a clause. */
const atomCovers = (atom: CfcAtom): BrowserReleaseCovers => {
  const type = field(atom, "type");
  if (type === CFC_ATOM_TYPE.Origin) {
    return BROWSER_RELEASE_PUBLIC_WEB;
  }
  if (type === CFC_ATOM_TYPE.Caveat) {
    const kind = field(atom, "kind");
    const source = field(atom, "source");
    return typeof kind === "string" && PROMPT_CAVEAT_KINDS.has(kind) &&
        isObjectNotArray(source) &&
        source.type === CFC_ATOM_TYPE.Resource &&
        typeof source.class === "string" &&
        BROWSER_OBSERVATION_CLASSES.has(source.class)
      ? BROWSER_RELEASE_PUBLIC_WEB
      : [];
  }
  if (type === CFC_ATOM_TYPE.Service) {
    const subject = field(atom, "subject");
    const origin = typeof subject === "string"
      ? didWebOrigin(subject)
      : undefined;
    return origin === undefined ? [] : [origin];
  }
  return [];
};

const union = (
  left: BrowserReleaseCovers,
  right: BrowserReleaseCovers,
): BrowserReleaseCovers =>
  left === BROWSER_RELEASE_PUBLIC_WEB || right === BROWSER_RELEASE_PUBLIC_WEB
    ? BROWSER_RELEASE_PUBLIC_WEB
    : [...new Set([...left, ...right])];

/** The origins both `left` and `right` cover. */
export const intersectBrowserReleaseCovers = (
  left: BrowserReleaseCovers,
  right: BrowserReleaseCovers,
): BrowserReleaseCovers =>
  left === BROWSER_RELEASE_PUBLIC_WEB
    ? right
    : right === BROWSER_RELEASE_PUBLIC_WEB
    ? left
    : left.filter((origin) => right.includes(origin));

/**
 * Where a clause may go: wherever any of its alternatives may, since an
 * audience that satisfies one alternative satisfies the clause.
 */
const clauseCovers = (clause: CfcConfClause): BrowserReleaseCovers =>
  clauseAlternatives(clause).reduce<BrowserReleaseCovers>(
    (covers, atom) => union(covers, atomCovers(atom)),
    [],
  );

/**
 * Where a payload made of `parts` may go: where every clause of every part
 * may go, a part's own destinations included.
 */
export const browserReleaseCoverage = (
  parts: readonly BrowserReleasePart[],
): BrowserReleaseCovers =>
  parts.reduce<BrowserReleaseCovers>(
    (covers, part) =>
      (part.label?.confidentiality ?? []).reduce<BrowserReleaseCovers>(
        (partCovers, clause) =>
          intersectBrowserReleaseCovers(
            partCovers,
            union(clauseCovers(clause), part.releasedTo ?? []),
          ),
        covers,
      ),
    BROWSER_RELEASE_PUBLIC_WEB,
  );

/** What {@link decideBrowserRelease} decided. */
export type BrowserReleaseOutcome =
  | {
    /** The sink the operation sends to: `browser.` and its action. */
    sink: string;

    /** Where the operation may send, and the session may go from now on. */
    covers: BrowserReleaseCovers;

    /** The decision as the run's policy trace records it, when it records one. */
    record?: HarnessReleaseDecision;
    refused?: undefined;
  }
  | {
    sink?: undefined;
    covers?: undefined;
    record: HarnessReleaseDecision;

    /** Why, in words the run may read: the sink and the destination. */
    refused: string;
  };

/** Whether `mode` refuses what a release decision does not cover. */
const enforcing = (mode: CfcEnforcementMode): boolean =>
  mode === "enforce-explicit" || mode === "enforce-strict";

/**
 * Decides whether an operation of `action` may send `parts` into a session
 * whose earlier sends may go only where `session.covers` says, the
 * operation's own payload going to `destination` when the harness knows the
 * origin that receives it.
 *
 * A released operation may send where both its payload and everything
 * already in the session may go, and `session.covers` narrows to that, since
 * the session holds the payload from then on. Under enforcement, an operation
 * whose destination that does not cover is refused before anything is sent.
 * Under observation it goes ahead covering the open web, and the decision is
 * recorded as one enforcement would have refused; with CFC disabled it goes
 * ahead and nothing is recorded.
 */
export const decideBrowserRelease = (
  session: { covers: BrowserReleaseCovers },
  options: {
    action: string;
    parts: readonly BrowserReleasePart[];
    destination: string | undefined;
    mode: CfcEnforcementMode;
  },
): BrowserReleaseOutcome => {
  const sink = `browser.${options.action}`;
  const covers = intersectBrowserReleaseCovers(
    session.covers,
    browserReleaseCoverage(options.parts),
  );
  const covered = options.destination === undefined ||
    browserReleaseCovers(covers, options.destination);
  const audience = options.destination === undefined
    ? {}
    : { audience: options.destination };
  if (!covered && enforcing(options.mode)) {
    return {
      record: {
        reasonCode: "cfc_release_refused",
        boundary: "release",
        sink,
        ...audience,
      },
      refused:
        `${sink} to ${options.destination} is refused: this run holds what it read on pages or in the owner's space, and that may not be sent there`,
    };
  }
  session.covers = covers;
  const sent = enforcing(options.mode) ? covers : BROWSER_RELEASE_PUBLIC_WEB;
  return covered || options.mode === "disabled" ? { sink, covers: sent } : {
    sink,
    covers: sent,
    record: {
      reasonCode: "cfc_release_observed",
      boundary: "release",
      sink,
      ...audience,
    },
  };
};
