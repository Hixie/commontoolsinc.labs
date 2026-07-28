import { Browser, type Page } from "@commonfabric/integration";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  CLICK_TARGET_ATTR,
  clickCfButton,
  clickCfButtonsConcurrently,
  clickNthCfButton,
  clickTrustedAction,
} from "./cfc-browser-helpers.ts";

/** One element's live click marks, in attribute order. */
type MarkProbe = { clicks: number; marksAtClick: string[]; marks: string[] };

describe("CFC browser helpers", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await Browser.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("settles the view before clicking a rendered control", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "lp-guest-button";
      button.textContent = "Continue as guest";
      root.append(button);
      document.body.append(host);

      let settleCalls = 0;
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __settleCalls: () => number;
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          button.addEventListener("click", () => {
            const input = document.createElement("input");
            input.id = "lp-join-name";
            document.body.append(input);
          }, { once: true });
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __settleCalls: () => number;
      }).__settleCalls = () => settleCalls;
    });

    await clickCfButton(page, "#lp-guest-button");

    const result = await page.evaluate(() => ({
      inputPresent: document.querySelector("#lp-join-name") !== null,
      settleCalls: (globalThis as typeof globalThis & {
        __settleCalls: () => number;
      }).__settleCalls(),
    }));
    assert(
      result.inputPresent,
      'clicking "Continue as guest" did not reveal #lp-join-name',
    );
    assertEquals(result.settleCalls, 3);
  });

  it("rejects when the settlement hook vanishes before invocation", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "vanishing-settle-button";
      button.textContent = "Open";
      root.append(button);
      document.body.append(host);

      let accesses = 0;
      let clicks = 0;
      let settles = 0;
      const settle = () => {
        settles++;
        button.addEventListener("click", () => clicks++, { once: true });
        return Promise.resolve();
      };
      (globalThis as typeof globalThis & {
        commonfabric: {
          readonly viewSettled?: () => Promise<void>;
        };
        __vanishingSettleResult: () => {
          accesses: number;
          clicks: number;
          settles: number;
        };
      }).commonfabric = {
        get viewSettled() {
          accesses++;
          return accesses % 2 === 1 ? settle : undefined;
        },
      };
      (globalThis as typeof globalThis & {
        __vanishingSettleResult: () => {
          accesses: number;
          clicks: number;
          settles: number;
        };
      }).__vanishingSettleResult = () => ({ accesses, clicks, settles });
    });

    const error = await assertRejects(
      () => clickCfButton(page, "#vanishing-settle-button"),
      Error,
    );
    assert(
      error.cause instanceof Error &&
        error.cause.message.includes("disappeared before settlement"),
      `unexpected vanished-hook failure: ${error.stack}`,
    );
    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __vanishingSettleResult: () => {
          accesses: number;
          clicks: number;
          settles: number;
        };
      }).__vanishingSettleResult()
    );
    assertEquals(result.settles, 0);
    assertEquals(result.clicks, 0);
  });

  it("settles after a late control arrives before clicking it", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      document.body.append(host);

      let settleCalls = 0;
      let clickedAtSettle = 0;
      let bound = false;
      const bind = () => {
        const button = root.querySelector("#late-vote-button");
        if (!button || bound) return;
        bound = true;
        button.addEventListener("click", () => {
          clickedAtSettle = settleCalls;
        }, { once: true });
      };

      const arrival = new MessageChannel();
      arrival.port1.addEventListener("message", () => {
        const button = document.createElement("button");
        button.id = "late-vote-button";
        button.textContent = "Veto";
        root.append(button);
        arrival.port1.close();
        arrival.port2.close();
      }, { once: true });
      arrival.port1.start();

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          bind();
          if (settleCalls === 1) arrival.port2.postMessage(undefined);
          return Promise.resolve();
        },
      };

      (globalThis as typeof globalThis & {
        __lateClickResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateClickResult = () => ({ settleCalls, clickedAtSettle });
    });

    await clickCfButton(page, "#late-vote-button");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __lateClickResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__lateClickResult()
    );
    assert(
      result.clickedAtSettle > 0,
      "the click reached no handler because the target arrived after the " +
        "pre-click settle",
    );
    assertEquals(result.settleCalls, 3);
  });

  it("settles again when a control arrives during settlement", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      document.body.append(host);

      let settleCalls = 0;
      let clickedAtSettle = 0;
      let bound = false;
      let created = false;
      const bind = () => {
        const button = root.querySelector("#during-settle-button");
        if (!button || bound) return;
        bound = true;
        button.addEventListener("click", () => {
          clickedAtSettle = settleCalls;
        }, { once: true });
      };

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
      }).commonfabric = {
        viewSettled: async () => {
          settleCalls++;
          bind();
          if (!created) {
            await Promise.resolve();
            const button = document.createElement("button");
            button.id = "during-settle-button";
            button.textContent = "Open";
            root.append(button);
            created = true;
          }
        },
      };

      (globalThis as typeof globalThis & {
        __duringSettleClickResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__duringSettleClickResult = () => ({
        settleCalls,
        clickedAtSettle,
      });
    });

    await clickCfButton(page, "#during-settle-button");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __duringSettleClickResult: () => {
          settleCalls: number;
          clickedAtSettle: number;
        };
      }).__duringSettleClickResult()
    );
    assert(
      result.clickedAtSettle > 0,
      "the control was clicked before a settle began with it present",
    );
    assertEquals(result.settleCalls, 3);
  });

  it("rejects a control hidden by target-present settlement", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "hidden-during-settle-button";
      button.textContent = "Open";
      root.append(button);
      document.body.append(host);

      let settleCalls = 0;
      let clicks = 0;
      button.addEventListener("click", () => clicks++);
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __hiddenDuringSettleResult: () => {
          clicks: number;
          settleCalls: number;
        };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (settleCalls === 2) button.style.display = "none";
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __hiddenDuringSettleResult: () => {
          clicks: number;
          settleCalls: number;
        };
      }).__hiddenDuringSettleResult = () => ({ clicks, settleCalls });
    });

    const error = await assertRejects(
      () => clickCfButton(page, "#hidden-during-settle-button"),
      Error,
    );
    assert(
      error.cause instanceof Error &&
        error.cause.message.includes("stopped being rendered while settling"),
      `unexpected hidden-target failure: ${error.stack}`,
    );
    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __hiddenDuringSettleResult: () => {
          clicks: number;
          settleCalls: number;
        };
      }).__hiddenDuringSettleResult()
    );
    assertEquals(result.clicks, 0);
    assertEquals(result.settleCalls, 2);
  });

  it("settles the view after clicking so local effects render", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "post-settle-guest-button";
      button.textContent = "Continue as guest";
      root.append(button);
      document.body.append(host);

      let clicked = false;
      let settleCalls = 0;
      button.addEventListener("click", () => {
        clicked = true;
      }, { once: true });
      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __postSettleCalls: () => number;
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          if (clicked) {
            const input = document.createElement("input");
            input.id = "post-settle-join-name";
            document.body.append(input);
          }
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __postSettleCalls: () => number;
      }).__postSettleCalls = () => settleCalls;
    });

    await clickCfButton(page, "#post-settle-guest-button");

    const result = await page.evaluate(() => ({
      inputPresent: document.querySelector("#post-settle-join-name") !== null,
      settleCalls: (globalThis as typeof globalThis & {
        __postSettleCalls: () => number;
      }).__postSettleCalls(),
    }));
    assert(
      result.inputPresent,
      "the click effect was not applied by a post-click view settle",
    );
    assertEquals(result.settleCalls, 3);
  });

  it("marks grouped targets between settlement barriers", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      let settleCalls = 0;
      const settleCallsAtClick: number[] = [];
      const createButton = (id: string) => {
        const button = document.createElement("button");
        button.id = id;
        button.textContent = id;
        return button;
      };
      const firstButton = createButton("grouped-button-a");
      const secondButton = createButton("grouped-button-b");
      let secondTargetMarkedAtFirstClick = false;
      firstButton.addEventListener("click", () => {
        if (settleCallsAtClick.length === 0) {
          secondTargetMarkedAtFirstClick = secondButton.hasAttribute(
            clickTargetAttr,
          );
        }
        settleCallsAtClick.push(settleCalls);
      });
      secondButton.addEventListener("click", () => {
        settleCallsAtClick.push(settleCalls);
      }, { once: true });
      root.append(firstButton, secondButton);
      document.body.append(host);

      (globalThis as typeof globalThis & {
        commonfabric: { viewSettled: () => Promise<void> };
        __groupedClickResult: () => {
          settleCalls: number;
          settleCallsAtClick: number[];
          secondTargetMarkedAtFirstClick: boolean;
        };
      }).commonfabric = {
        viewSettled: () => {
          settleCalls++;
          return Promise.resolve();
        },
      };
      (globalThis as typeof globalThis & {
        __groupedClickResult: () => {
          settleCalls: number;
          settleCallsAtClick: number[];
          secondTargetMarkedAtFirstClick: boolean;
        };
      }).__groupedClickResult = () => ({
        settleCalls,
        settleCallsAtClick,
        secondTargetMarkedAtFirstClick,
      });
    }, { args: [CLICK_TARGET_ATTR] });

    await clickCfButtonsConcurrently([
      { page, selector: "#grouped-button-a" },
      { page, selector: "#grouped-button-b" },
      { page, selector: "#grouped-button-a" },
    ]);

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __groupedClickResult: () => {
          settleCalls: number;
          settleCallsAtClick: number[];
          secondTargetMarkedAtFirstClick: boolean;
        };
      }).__groupedClickResult()
    );
    assertEquals(result.settleCallsAtClick, [2, 2, 2]);
    assertEquals(result.settleCalls, 3);
    assert(
      result.secondTargetMarkedAtFirstClick,
      `the second target did not carry ${CLICK_TARGET_ATTR} before dispatch`,
    );
  });

  // Every mark predicate adds its token to the marks already on the element, so
  // a target another click has spoken for keeps that claim. The grouped test
  // above exercises that for the by-selector predicate; these two cover the
  // indexed and trusted-action ones.

  it("keeps a co-resident mark when tagging an indexed target", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const first = document.createElement("button");
      first.className = "indexed-target";
      first.textContent = "first";
      const second = document.createElement("button");
      second.className = "indexed-target";
      second.textContent = "second";
      second.setAttribute(clickTargetAttr, "held-by-another-click");
      let clicks = 0;
      let marksAtClick: string[] = [];
      const marksOf = (element: Element): string[] =>
        (element.getAttribute(clickTargetAttr) ?? "").split(/\s+/).filter(
          Boolean,
        );
      second.addEventListener("click", () => {
        clicks++;
        marksAtClick = marksOf(second);
      });
      root.append(first, second);
      document.body.append(host);

      (globalThis as typeof globalThis & {
        __indexedMarkProbe: () => unknown;
      }).__indexedMarkProbe = () => ({
        clicks,
        marksAtClick,
        marks: marksOf(second),
      });
    }, { args: [CLICK_TARGET_ATTR] });

    await clickNthCfButton(page, ".indexed-target", 1);

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __indexedMarkProbe: () => MarkProbe;
      }).__indexedMarkProbe()
    ) as MarkProbe;
    assertEquals(result.clicks, 1);
    // Both marks are live when the click lands, and only this helper's own
    // mark is cleared afterwards.
    assert(
      result.marksAtClick.includes("held-by-another-click"),
      `the pre-existing mark was lost: ${result.marksAtClick.join(" ")}`,
    );
    assertEquals(result.marksAtClick.length, 2);
    assertEquals(result.marks, ["held-by-another-click"]);
  });

  it("keeps a co-resident mark when tagging a trusted action", async () => {
    await page.evaluate((clickTargetAttr: string) => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.setAttribute("data-ui-action", "save-note");
      button.textContent = "Save";
      button.setAttribute(clickTargetAttr, "held-by-another-click");
      let clicks = 0;
      let marksAtClick: string[] = [];
      const marksOf = (element: Element): string[] =>
        (element.getAttribute(clickTargetAttr) ?? "").split(/\s+/).filter(
          Boolean,
        );
      button.addEventListener("click", () => {
        clicks++;
        marksAtClick = marksOf(button);
      });
      root.append(button);
      document.body.append(host);

      (globalThis as typeof globalThis & {
        __trustedMarkProbe: () => unknown;
      }).__trustedMarkProbe = () => ({
        clicks,
        marksAtClick,
        marks: marksOf(button),
      });
    }, { args: [CLICK_TARGET_ATTR] });

    await clickTrustedAction(page, "save-note");

    const result = await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __trustedMarkProbe: () => MarkProbe;
      }).__trustedMarkProbe()
    ) as MarkProbe;
    assertEquals(result.clicks, 1);
    assert(
      result.marksAtClick.includes("held-by-another-click"),
      `the pre-existing mark was lost: ${result.marksAtClick.join(" ")}`,
    );
    assertEquals(result.marksAtClick.length, 2);
    assertEquals(result.marks, ["held-by-another-click"]);
  });
});
