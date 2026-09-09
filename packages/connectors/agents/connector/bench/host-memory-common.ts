/** Bounded control messages and memory samples for the opt-in host benchmark. */

import { TextLineStream } from "@std/streams/text-line-stream";
import type { AgentSourceConfig } from "../src/types.ts";
import {
  collectGarbage,
  ProfileLog,
} from "../../../../memory/test/agents-storage-profile-probes.ts";

export interface ProfileConfig {
  directory: string;
  dataset: string;
  identityPath: string;

  /** Browser authentication key, defaulting to `identityPath`. */
  browserIdentityPath?: string;

  ownerDid: string;
  spaceDid?: string;
  apiUrl?: string;
  sources: AgentSourceConfig[];
  readBytes: number;
  pageBytes: number;
  debugView: boolean;
  legacyIds?: string[];
  legacyPieceId?: string;
  shellRoot?: string;
}

export const config: ProfileConfig = JSON.parse(
  await Deno.readTextFile(Deno.args[0]),
);
export const role = Deno.args[1];
export const log = new ProfileLog(`${config.directory}/${role}.jsonl`);
const control = await Deno.connect({
  transport: "unix",
  path: `${config.directory}/${role}.socket`,
});
const encoder = new TextEncoder();

/** Emits bounded benchmark control replies separately from application logs. */
export async function reply(id: string, value: unknown): Promise<void> {
  const bytes = encoder.encode(JSON.stringify({ id, value }) + "\n");
  for (let offset = 0; offset < bytes.length;) {
    offset += await control.write(bytes.subarray(offset));
  }
}

/** Samples retained memory after the caller has drained its asynchronous work. */
export function settled(stage: string, details: Record<string, unknown> = {}) {
  log.write(`${stage}-before-gc`, details);
  collectGarbage();
  return log.write(stage, details);
}

/** Commands arrive through a private inherited pipe, outside the HTTP service. */
export async function commands(
  handle: (command: Record<string, unknown>) => Promise<unknown>,
) {
  for await (
    const line of Deno.stdin.readable.pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream())
  ) {
    const command = JSON.parse(line);
    log.write("command-begin", {
      operation: command.op,
      requestedStage: command.stage,
    });
    try {
      await reply(command.id, await handle(command));
    } catch (error) {
      await reply(command.id, {
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
    if (command.op === "stop") break;
  }
  control.close();
  log.close();
}
