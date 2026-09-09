/** Opens a saved piece URL in the production shell and measures its worker. */

import { BrowserProcess } from "@commonfabric/integration/browser-process";
import { Identity } from "@commonfabric/identity";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import "../../../../shell/src/globals.ts";
import type { XRootView } from "../../../../shell/src/views/RootView.ts";
import type { XAppView } from "../../../../shell/src/views/AppView.ts";
import type { CFAgentArchive } from "../../../../ui/src/v2/components/cf-agent-archive/cf-agent-archive.ts";
import {
  commands,
  config,
  log,
  reply,
  role,
  settled,
} from "./host-memory-common.ts";
import { ProfileCdp } from "./host-memory-cdp.ts";

declare global {
  var profileShellReady: Promise<XRootView>;
}

const browser = await BrowserProcess.start({
  headless: true,
  args: [`--user-data-dir=${config.directory}/${role}-profile`],
});
using cdp = await ProfileCdp.connect(browser.wsEndpoint());
const page = await browser.newPage();
const bindings = page.unsafelyGetCelestialBindings();
await bindings.Page.enable();
const { targetInfo } = await bindings.Target.getTargetInfo({});
await cdp.observeWorkers(targetInfo.targetId);
await bindings.Page.addScriptToEvaluateOnNewDocument({
  source: `
globalThis.profileShellReady = new Promise((resolve, reject) => {
  const failed = (event) => reject(new Error(event.message || "Shell bootstrap failed"));
  globalThis.addEventListener("error", failed, { once: true });
  Object.defineProperty(globalThis, "app", {
    configurable: true,
    set(value) {
      Object.defineProperty(globalThis, "app", { value, configurable: true, writable: true });
      globalThis.removeEventListener("error", failed);
      resolve(value);
    },
  });
});`,
});
const top = (await cdp.send("SystemInfo.getProcessInfo")).processInfo as {
  id: number;
  type: string;
}[];
const main = top.find((process) => process.type === "browser");
if (!main) throw new Error("Chrome did not identify its main process");
const process = await new Deno.Command("ps", {
  args: ["-o", "command=", "-p", String(main.id)],
  stdout: "piped",
  stderr: "piped",
}).output();
if (
  !process.success ||
  !new TextDecoder().decode(process.stdout).includes("--headless=new")
) throw new Error("The benchmark browser must use --headless=new");
await reply("ready", { pid: Deno.pid, chromePid: main.id, headless: true });
let sample: Promise<void> = Promise.resolve();
let sampling = false;
let samplingError: unknown;
const timer = setInterval(() => {
  if (sampling) return;
  sampling = true;
  sample = cdp.sample(false).then((browser) => {
    log.write("browser-sample", { browser });
  }).catch((error) => {
    samplingError = error;
  }).finally(() => {
    sampling = false;
  });
}, 1000);

try {
  await commands(async (command) => {
    if (samplingError) throw samplingError;
    if (command.op === "visit") {
      const pieceId = String(command.pieceId);
      const space = String(command.space ?? config.spaceDid);
      const url = new URL(config.apiUrl!);
      url.pathname = `/${space}/${pieceId}`;
      await page.goto(url.href);
      const identity = await Identity.fromPkcs8(
        await Deno.readFile(config.browserIdentityPath ?? config.identityPath),
        { implementation: "noble" },
      );
      const state = await page.evaluate(async (serialized) => {
        try {
          const root = await globalThis.profileShellReady;
          if (!root) {
            throw new Error("The shell readiness hook was not installed");
          }
          await root.setIdentity(serialized);
          await root.accessForTestingOnly.rt.taskComplete;
          await root.updateComplete;
          const view = root.shadowRoot?.querySelector<XAppView>("x-app-view");
          if (!view) throw new Error("The shell did not render its app view");
          await view.updateComplete;
          await view._selectedPattern.taskComplete;
          await globalThis.commonfabric.rt?.idle();
          await view.updateComplete;
          return {
            url: location.href,
            status: view._selectedPattern.status,
            title: document.title,
          };
        } catch (error) {
          return {
            bootstrapError: error instanceof Error
              ? error.message
              : String(error),
            stack: error instanceof Error
              ? error.stack?.slice(0, 2000)
              : undefined,
          };
        }
      }, { args: [jsonFromFabricValue(identity.keyPair)] });
      return settled("visited", { state, browser: await cdp.sample() });
    }
    if (command.op === "navigate") {
      const result = await page.evaluate(async (action) => {
        function find(root: Document | ShadowRoot): CFAgentArchive | undefined {
          const direct = root.querySelector<CFAgentArchive>("cf-agent-archive");
          if (direct) return direct;
          for (const element of root.querySelectorAll("*")) {
            const nested = element.shadowRoot && find(element.shadowRoot);
            if (nested) return nested;
          }
        }
        const archive = find(document);
        if (!archive) {
          throw new Error("The registered view did not render its archive");
        }
        await archive.accessForTestingOnly.idle;
        await archive.updateComplete;
        if (action.label || action.row !== undefined) {
          const row = action.row === undefined ? undefined : archive.shadowRoot!
            .querySelectorAll("tbody tr")[action.row];
          const buttons = (row ?? archive.shadowRoot!).querySelectorAll(
            "button",
          );
          const label = row ? "Inspect" : action.label;
          const button = [...buttons].find((button) => {
            const text = button.textContent?.trim() ?? "";
            return text === label || text.startsWith(`${label} ·`);
          });
          if (!button || button.disabled) {
            throw new Error(`Archive action is unavailable: ${label}`);
          }
          button.click();
          await archive.accessForTestingOnly.idle;
          await archive.updateComplete;
        }
        const root = archive.shadowRoot!;
        return {
          rows: root.querySelectorAll("tbody tr").length,
          textBytes: new TextEncoder().encode(root.textContent ?? "").length,
          downloads: root.querySelectorAll("a[download]").length,
          error: root.querySelector("[role=alert]")?.textContent,
        };
      }, {
        args: [{
          label: String(command.label ?? ""),
          row: command.row as number | undefined,
        }],
      });
      if (result.error) throw new Error(result.error);
      return settled("navigated", { result, browser: await cdp.sample() });
    }
    if (command.op === "close-view") {
      await page.evaluate(async () => {
        function find(root: Document | ShadowRoot): CFAgentArchive | undefined {
          const direct = root.querySelector<CFAgentArchive>("cf-agent-archive");
          if (direct) return direct;
          for (const element of root.querySelectorAll("*")) {
            const nested = element.shadowRoot && find(element.shadowRoot);
            if (nested) return nested;
          }
        }
        const archive = find(document);
        if (!archive) throw new Error("Archive view is not open");
        archive.remove();
        await archive.accessForTestingOnly.idle;
        await globalThis.commonfabric.rt!.idle();
      });
      return settled("view-closed", { browser: await cdp.sample() });
    }
    if (command.op === "sample") {
      return settled(String(command.stage), { browser: await cdp.sample() });
    }
    if (command.op === "stop") {
      clearInterval(timer);
      await sample;
      return settled("closing");
    }
    throw new Error("Unknown browser profile command");
  });
} finally {
  clearInterval(timer);
  await sample;
  await browser.close();
}
