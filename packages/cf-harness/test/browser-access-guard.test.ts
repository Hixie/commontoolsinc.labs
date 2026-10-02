import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { HarnessBrowserAccessLease } from "../src/contracts/browser-access.ts";
import {
  browserAccessGuardOf,
  BrowserAccessNavigationGuard,
  browserAccessReleaseOf,
  closeBrowserAccessGuard,
} from "../src/tools/browser-access-guard.ts";
import { FakeCdpBrowser } from "./fake-cdp-browser.ts";

const BANK = "https://bank.example";

describe("browser-access-guard", () => {
  let browser: FakeCdpBrowser;

  beforeEach(() => {
    browser = new FakeCdpBrowser();
  });

  afterEach(async () => {
    await browser.close();
  });

  describe("BrowserAccessNavigationGuard", () => {
    it("asks the browser to attach it to every page, each held until it is guarded", async () => {
      const guard = await BrowserAccessNavigationGuard.connect(browser.origin);

      const sessionId = await browser.openPage("page-1");
      const resumed = await browser.command(
        "Runtime.runIfWaitingForDebugger",
        true,
      );

      expect(browser.commands[0]).toEqual({
        method: "Target.setAutoAttach",
        params: {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "page" }],
        },
      });
      const enabled = browser.commands.findIndex((command) =>
        command.method === "Fetch.enable"
      );
      expect(browser.commands[enabled]).toEqual({
        method: "Fetch.enable",
        params: {
          patterns: [{ resourceType: "Document", requestStage: "Request" }],
        },
        sessionId,
      });
      expect(browser.commands.indexOf(resumed)).toBeGreaterThan(enabled);
      guard.close();
    });

    it("lets every navigation go while it covers the open web", async () => {
      const guard = await BrowserAccessNavigationGuard.connect(browser.origin);
      const sessionId = await browser.openPage("page-1");

      expect(
        await browser.navigate(sessionId, "page-1", "https://shop.example/"),
      ).toBe("continued");
      expect(guard.takeRefused()).toEqual([]);
      guard.close();
    });

    it("fails a page's navigation to an origin it does not cover, and returns that origin once", async () => {
      const guard = await BrowserAccessNavigationGuard.connect(browser.origin);
      const sessionId = await browser.openPage("page-1");
      guard.arm([BANK]);

      expect(
        await browser.navigate(sessionId, "page-1", `${BANK}/transfer`),
      ).toBe("continued");
      expect(
        await browser.navigate(
          sessionId,
          "page-1",
          "https://collector.example/?balance=1234",
        ),
      ).toBe("failed");
      expect(guard.takeRefused()).toEqual(["https://collector.example"]);
      expect(guard.takeRefused()).toEqual([]);
      const failed = browser.commands.find((command) =>
        command.method === "Fetch.failRequest"
      );
      expect(failed?.params.errorReason).toBe("BlockedByClient");
      guard.close();
    });

    it("guards a page opened after it attached", async () => {
      const guard = await BrowserAccessNavigationGuard.connect(browser.origin);
      guard.arm([BANK]);
      await browser.openPage("page-1");
      const opened = await browser.openPage("page-2");

      expect(
        await browser.navigate(opened, "page-2", "https://collector.example/"),
      ).toBe("failed");
      guard.close();
    });

    it("lets a frame within a page load from any origin", async () => {
      const guard = await BrowserAccessNavigationGuard.connect(browser.origin);
      const sessionId = await browser.openPage("page-1");
      guard.arm([BANK]);

      expect(
        await browser.navigate(sessionId, "frame-7", "https://ads.example/"),
      ).toBe("continued");
      expect(guard.takeRefused()).toEqual([]);
      guard.close();
    });

    it("says why it ended once the browser disconnects it", async () => {
      const guard = await BrowserAccessNavigationGuard.connect(browser.origin);
      expect(guard.ended).toBeUndefined();

      browser.disconnect();

      expect(await guard.whenEnded).toContain("closed");
      expect(guard.ended).toContain("closed");
    });

    it("throws when the endpoint names no DevTools socket", async () => {
      const silent = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        () => Response.json({}),
      );
      await expect(
        BrowserAccessNavigationGuard.connect(
          `http://127.0.0.1:${silent.addr.port}`,
        ),
      ).rejects.toThrow("named no DevTools socket");
      await silent.shutdown();
    });
  });

  describe("browserAccessGuardOf()", () => {
    const lease = (): HarnessBrowserAccessLease => ({
      type: "cf-harness.chat.browser-access-lease",
      leaseId: crypto.randomUUID(),
      cdpUrl: browser.origin,
    });

    it("attaches one guard per lease, armed with where its browser may go", async () => {
      const leased = lease();
      browserAccessReleaseOf(leased).covers = [BANK];

      const guard = await browserAccessGuardOf(leased, browser.origin);
      const sessionId = await browser.openPage("page-1");

      expect(await browserAccessGuardOf(leased, browser.origin)).toBe(guard);
      expect(
        await browser.navigate(sessionId, "page-1", "https://shop.example/"),
      ).toBe("failed");
      closeBrowserAccessGuard(leased);
    });

    it("attaches a new guard after the last one was closed, keeping where the browser may go", async () => {
      const leased = lease();
      browserAccessReleaseOf(leased).covers = [BANK];
      const first = await browserAccessGuardOf(leased, browser.origin);

      closeBrowserAccessGuard(leased);
      const second = await browserAccessGuardOf(leased, browser.origin);
      const sessionId = await browser.openPage("page-1");

      expect(second).not.toBe(first);
      expect(first.ended).toBeDefined();
      expect(browserAccessReleaseOf(leased).covers).toEqual([BANK]);
      expect(
        await browser.navigate(sessionId, "page-1", "https://shop.example/"),
      ).toBe("failed");
      closeBrowserAccessGuard(leased);
    });
  });
});
