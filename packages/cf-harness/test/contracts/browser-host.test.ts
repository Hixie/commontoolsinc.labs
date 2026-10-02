import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  browserActionSends,
  browserReleaseCovers,
  verifyBrowserReleaseDecision,
} from "../../src/contracts/browser-host.ts";

describe("browser-host", () => {
  describe("browserReleaseCovers()", () => {
    it("returns `true` for an origin of the open web under the open web", () => {
      expect(browserReleaseCovers("public-web", "https://shop.example")).toBe(
        true,
      );
      expect(browserReleaseCovers("public-web", "http://shop.example:8080"))
        .toBe(true);
    });

    it("returns `false` under the open web for this device, its network, an IP literal, or no http(s) origin", () => {
      for (
        const origin of [
          "http://localhost:8000",
          "https://printer.local",
          "https://10.0.0.1",
          "https://[::1]",
          "file:///etc/passwd",
          "null",
          "https://shop.example/path",
        ]
      ) {
        expect(browserReleaseCovers("public-web", origin)).toBe(false);
      }
    });

    it("returns whether a list of origins names the origin", () => {
      expect(
        browserReleaseCovers(["https://bank.example"], "https://bank.example"),
      ).toBe(true);
      expect(
        browserReleaseCovers(["https://bank.example"], "https://shop.example"),
      ).toBe(false);
      expect(browserReleaseCovers([], "https://bank.example")).toBe(false);
    });
  });

  describe("browserActionSends()", () => {
    it("returns `true` for every action the page can observe", () => {
      for (
        const action of [
          "open",
          "back",
          "forward",
          "reload",
          "scroll",
          "click",
          "check",
          "press",
          "fill",
          "type",
          "select",
        ]
      ) {
        expect(browserActionSends(action)).toBe(true);
      }
    });

    it("returns `true` for a read of a selector's text and `false` for a ref's", () => {
      expect(browserActionSends("get", "#account-4471")).toBe(true);
      expect(browserActionSends("get", "@e3")).toBe(false);
      expect(browserActionSends("get")).toBe(false);
    });

    it("returns `false` for the reads", () => {
      for (
        const action of [
          "snapshot",
          "screenshot",
          "console",
          "errors",
          "wait",
          "handoff",
        ]
      ) {
        expect(browserActionSends(action)).toBe(false);
      }
    });
  });

  describe("verifyBrowserReleaseDecision()", () => {
    const decision = {
      sequence: 4,
      sink: "browser.open",
      covers: ["https://bank.example"],
    };

    it("returns `undefined` for the decision issued for the operation", () => {
      expect(
        verifyBrowserReleaseDecision(
          { action: "open", url: "https://bank.example/", decision },
          4,
        ),
      ).toBeUndefined();
      expect(
        verifyBrowserReleaseDecision(
          { action: "snapshot", interactive: false },
          1,
        ),
      )
        .toBeUndefined();
    });

    it("returns why for a sending operation with no decision", () => {
      expect(
        verifyBrowserReleaseDecision({ action: "click", ref: "@e1" }, 1),
      ).toContain("needs a release decision");
    });

    it("returns why for a decision issued for another sink or another operation", () => {
      expect(
        verifyBrowserReleaseDecision({
          action: "fill",
          ref: "@e1",
          value: { kind: "text", text: "x" },
          decision,
        }, 4),
      ).toContain("is for browser.open, not browser.fill");
      expect(
        verifyBrowserReleaseDecision(
          { action: "open", url: "https://bank.example/", decision },
          5,
        ),
      ).toContain("is for operation 4, not operation 5");
    });

    it("returns why for a decision on an operation that sends nothing", () => {
      expect(
        verifyBrowserReleaseDecision({ action: "screenshot", decision }, 4),
      ).toContain("carries no release decision");
    });
  });
});
