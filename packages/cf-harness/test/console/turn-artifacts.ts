/**
 * A prompt loop that writes a turn's run artifacts the way a real one does,
 * for the console tests that read a completed turn's durable result.
 */

import { join } from "@std/path";

import type { HarnessInteractivePromptLoopFactory } from "../../src/interactive-chat-service.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../../src/prompt-loop.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";

/**
 * A loop that records the supplied completion in the run artifact directory.
 * This is the production ordering the console depends on: the prompt loop
 * persists its transcript before the service emits `turn_completed`.
 */
export const artifactLoop = (
  messages: readonly HarnessTranscriptMessage[],
  onCompleted?: () => void,
): HarnessInteractivePromptLoopFactory =>
(loopOptions) => ({
  runTranscript: async (
    options: RunHarnessTranscriptOptions,
  ): Promise<HarnessPromptLoopResult> => {
    if (
      loopOptions.artifactRoot === undefined || loopOptions.runId === undefined
    ) {
      throw new Error("artifact loop requires an artifact root and run id");
    }
    const transcript = [...options.transcript, ...messages];
    await writeTurnTranscript(
      loopOptions.artifactRoot,
      loopOptions.runId,
      transcript,
      options.transcript.length,
    );
    const finalAssistantText =
      transcript.findLast((message) => message.role === "assistant")?.content ??
        "";
    onCompleted?.();
    return {
      model: "gpt-test",
      finalAssistantText,
      transcript,
      modelTurns: 1,
      runState: {} as HarnessPromptLoopResult["runState"],
    };
  },
});

/** Writes the transcript and run report a turn's run leaves on disk. */
export const writeTurnTranscript = async (
  artifactRoot: string,
  turnId: string,
  transcript: readonly HarnessTranscriptMessage[],
  firstGeneratedIndex = 0,
): Promise<void> => {
  const runRoot = join(artifactRoot, turnId);
  await Deno.mkdir(runRoot, { recursive: true });
  await Deno.writeTextFile(
    join(runRoot, "transcript.json"),
    JSON.stringify(transcript),
  );
  await Deno.writeTextFile(
    join(runRoot, "run-report.json"),
    JSON.stringify({
      finalAssistantText: transcript.slice(firstGeneratedIndex).findLast(
        (message) => message.role === "assistant",
      )?.content ?? "",
      timeline: transcript.map((message, transcriptIndex) => ({
        kind: "transcript_message",
        transcriptIndex,
        role: message.role,
        ...(transcriptIndex >= firstGeneratedIndex ? { modelTurn: 1 } : {}),
      })),
    }),
  );
};
