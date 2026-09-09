/** Immutable archive disclosure policies evaluated with the runtime's CFC rules. */

import { cfcAtom } from "@commonfabric/api/cfc";
import { hashStringOf } from "@commonfabric/data-model";
import type { ArchiveAuthorization } from "@commonfabric/memory/v2/archive";

import { cfcLabelViewFromMetadata } from "./label-view-state.ts";
import {
  cfcConfidentialityForObservationNode,
  cfcObservationFitsCeiling,
} from "./observation.ts";
import type { CfcMetadata } from "./types.ts";
import { isCfcMetadata, isWalkableLabelMap } from "./metadata.ts";

/** Creates policies for one server-approved connector builtin. */
export function archiveAuthorization(
  writerPolicy: string,
): ArchiveAuthorization {
  return {
    authorizeLegacy(value, identity) {
      if (
        !isCfcMetadata(value) || !isWalkableLabelMap(value) ||
        value.labelMap.version !== 1 || value.labelMap.entries.length === 0
      ) return false;
      try {
        return value.labelMap.entries.every((entry) =>
          cfcObservationFitsCeiling(entry.label.confidentiality ?? [], [
            cfcAtom.user(identity.actingPrincipal),
          ])
        );
      } catch {
        return false;
      }
    },
    create(identity, readers) {
      const principals = [...new Set([identity.principal, ...readers])].sort();
      const label = {
        confidentiality: [{
          anyOf: principals.map((principal) => cfcAtom.user(principal)),
        }],
      };
      const metadata: CfcMetadata = {
        version: 1,
        schemaHash: hashStringOf(
          JSON.stringify({ version: 2, writerPolicy, label }),
        ),
        labelMap: { version: 1, entries: [{ path: [], label }] },
      };
      return { writerPolicy, cfcPolicy: JSON.stringify(metadata) };
    },
    authorize(binding, identity, access) {
      if (
        binding.schema !== 2 || binding.writerPolicy !== writerPolicy ||
        binding.space !== identity.space ||
        (access === "write" && binding.writer !== identity.principal)
      ) return false;
      try {
        const metadata = JSON.parse(binding.cfcPolicy) as CfcMetadata;
        if (
          !isCfcMetadata(metadata) || !isWalkableLabelMap(metadata) ||
          metadata.labelMap.version !== 1 ||
          metadata.labelMap.entries.length === 0
        ) return false;
        const confidentiality = cfcConfidentialityForObservationNode({
          labelView: cfcLabelViewFromMetadata(metadata, []),
        });
        return cfcObservationFitsCeiling(confidentiality, [
          cfcAtom.user(
            access === "read" ? identity.actingPrincipal : identity.principal,
          ),
        ]);
      } catch {
        return false;
      }
    },
  };
}
