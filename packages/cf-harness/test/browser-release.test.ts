import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  cfcAtom,
} from "@commonfabric/api/cfc";
import type { IFCLabel } from "@commonfabric/runner/cfc";

import {
  browserOwnerViewClause,
  browserReleaseCoverage,
  decideBrowserRelease,
  intersectBrowserReleaseCovers,
} from "../src/browser-release.ts";
import type { BrowserReleaseCovers } from "../src/contracts/browser-host.ts";

const OWNER = "did:key:z6MkownerOfTheseBrowserReleaseTests";
const BANK = "https://bank.example";
const SHOP = "https://shop.example";

/** What a page the browser observed carries: its origin and both caveats. */
const observedPage = (origin: string): IFCLabel => {
  const source = cfcAtom.resource("BrowserObservation", "run-1:browser:1");
  const by = { type: CFC_ATOM_TYPE.Origin, uri: origin, fetchedAt: 1 };
  return {
    confidentiality: [
      cfcAtom.caveat(
        CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
        source,
        by,
      ),
      cfcAtom.caveat(CFC_CONCEPT_KIND.PromptInfluence, source, by),
      by,
    ],
  };
};

/** What a page showing the owner's account on `origin` carries. */
const privatePage = (origin: string): IFCLabel => ({
  confidentiality: [
    ...observedPage(origin).confidentiality ?? [],
    browserOwnerViewClause(OWNER, origin),
  ],
});

/** A value from the owner's space. */
const ownerValue: IFCLabel = {
  confidentiality: [cfcAtom.space("did:key:z6MkownersSpace")],
};

const session = (covers: BrowserReleaseCovers = "public-web") => ({ covers });

describe("browser-release", () => {
  describe("browserReleaseCoverage()", () => {
    it("returns the open web for a payload with no label", () => {
      expect(browserReleaseCoverage([{ label: undefined }])).toBe(
        "public-web",
      );
    });

    it("returns the open web for what a browser observed on public pages", () => {
      expect(
        browserReleaseCoverage([
          { label: observedPage(SHOP) },
          { label: observedPage(BANK) },
        ]),
      ).toBe("public-web");
    });

    it("returns the one origin an owner-view clause names", () => {
      expect(browserReleaseCoverage([{ label: privatePage(BANK) }])).toEqual([
        BANK,
      ]);
    });

    it("returns the origin with its port for a host that names one", () => {
      expect(
        browserReleaseCoverage([{
          label: {
            confidentiality: [
              browserOwnerViewClause(OWNER, "https://bank.example:8443"),
            ],
          },
        }]),
      ).toEqual(["https://bank.example:8443"]);
    });

    it("returns nothing for what two origins showed the owner", () => {
      expect(
        browserReleaseCoverage([
          { label: privatePage(BANK) },
          { label: privatePage(SHOP) },
        ]),
      ).toEqual([]);
    });

    it("returns nothing for a value from the owner's space", () => {
      expect(browserReleaseCoverage([{ label: ownerValue }])).toEqual([]);
    });

    it("returns the owner's destinations for a value given them, and nothing more", () => {
      expect(
        browserReleaseCoverage([
          { label: observedPage(SHOP) },
          { label: ownerValue, releasedTo: [SHOP] },
        ]),
      ).toEqual([SHOP]);
    });

    it("returns nothing for a prompt caveat whose source is no browser observation", () => {
      expect(
        browserReleaseCoverage([{
          label: {
            confidentiality: [
              cfcAtom.caveat(
                CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
                cfcAtom.resource("EmailMessage", "message-1"),
              ),
            ],
          },
        }]),
      ).toEqual([]);
    });

    it("returns nothing for a service DID that names a path, this device, or no web host", () => {
      for (
        const subject of [
          "did:web:bank.example:accounts",
          "did:web:localhost%3A8000",
          "did:key:z6MkserviceKey",
        ]
      ) {
        expect(
          browserReleaseCoverage([{
            label: {
              confidentiality: [{
                anyOf: [cfcAtom.user(OWNER), cfcAtom.service(subject)],
              }],
            },
          }]),
        ).toEqual([]);
      }
    });
  });

  describe("intersectBrowserReleaseCovers()", () => {
    it("returns the origins both name, and the other side for the open web", () => {
      expect(intersectBrowserReleaseCovers([BANK, SHOP], [SHOP])).toEqual([
        SHOP,
      ]);
      expect(intersectBrowserReleaseCovers("public-web", [SHOP])).toEqual([
        SHOP,
      ]);
      expect(intersectBrowserReleaseCovers([BANK], "public-web")).toEqual([
        BANK,
      ]);
    });
  });

  describe("decideBrowserRelease()", () => {
    it("releases what a private page showed back to its own origin, and narrows the session to it", () => {
      const state = session();

      const outcome = decideBrowserRelease(state, {
        action: "fill",
        parts: [{ label: privatePage(BANK) }],
        destination: BANK,
        mode: "enforce-explicit",
      });

      expect(outcome).toEqual({ sink: "browser.fill", covers: [BANK] });
      expect(state.covers).toEqual([BANK]);
    });

    it("refuses what a private page showed on its way to another origin, and leaves the session as it was", () => {
      const state = session();

      const outcome = decideBrowserRelease(state, {
        action: "open",
        parts: [{ label: privatePage(BANK) }],
        destination: "https://collector.example",
        mode: "enforce-strict",
      });

      expect(outcome.refused).toContain(
        "browser.open to https://collector.example is refused",
      );
      expect(outcome.record).toEqual({
        reasonCode: "cfc_release_refused",
        boundary: "release",
        sink: "browser.open",
        audience: "https://collector.example",
      });
      expect(state.covers).toBe("public-web");
    });

    it("refuses a public payload into a session that holds another origin's private content", () => {
      const outcome = decideBrowserRelease(session([BANK]), {
        action: "open",
        parts: [{ label: observedPage(SHOP) }],
        destination: SHOP,
        mode: "enforce-explicit",
      });

      expect(outcome.refused).toBeDefined();
    });

    it("releases an operation whose destination the harness does not know under the session's coverage, for the host to hold", () => {
      const outcome = decideBrowserRelease(session(), {
        action: "back",
        parts: [{ label: privatePage(BANK) }],
        destination: undefined,
        mode: "enforce-explicit",
      });

      expect(outcome).toEqual({ sink: "browser.back", covers: [BANK] });
    });

    it("sends under observation with the open web as coverage, and records what enforcement would have refused", () => {
      const state = session();

      const outcome = decideBrowserRelease(state, {
        action: "type",
        parts: [{ label: ownerValue }],
        destination: SHOP,
        mode: "observe",
      });

      expect(outcome).toEqual({
        sink: "browser.type",
        covers: "public-web",
        record: {
          reasonCode: "cfc_release_observed",
          boundary: "release",
          sink: "browser.type",
          audience: SHOP,
        },
      });
      expect(state.covers).toEqual([]);
    });

    it("records nothing with CFC disabled", () => {
      const outcome = decideBrowserRelease(session(), {
        action: "type",
        parts: [{ label: ownerValue }],
        destination: SHOP,
        mode: "disabled",
      });

      expect(outcome).toEqual({ sink: "browser.type", covers: "public-web" });
    });

    it("records nothing for a covered operation under observation", () => {
      const outcome = decideBrowserRelease(session(), {
        action: "open",
        parts: [{ label: observedPage(BANK) }],
        destination: SHOP,
        mode: "observe",
      });

      expect(outcome.record).toBeUndefined();
    });
  });
});
