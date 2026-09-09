/** Verifies immutable archive policies against authenticated CFC principals. */

import { cfcAtom } from "@commonfabric/api/cfc";
import type {
  ArchiveBinding,
  ArchiveIdentity,
} from "@commonfabric/memory/v2/archive";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { archiveAuthorization } from "../../src/cfc/archive.ts";

const owner = "did:key:archive-owner";
const reader = "did:key:archive-reader";
const identity: ArchiveIdentity = {
  space: owner,
  principal: owner,
  actingPrincipal: owner,
  sessionId: "session",
  connectionId: "connection",
};
const authorization = archiveAuthorization("commonfabric.agents-connector");

function binding(): ArchiveBinding {
  return {
    id: "abc",
    handle: "of:handle",
    space: owner,
    owner,
    writer: owner,
    ...authorization.create(identity, [reader]),
    schema: 2,
    quotaBytes: 65536,
    quotaPages: 100,
    generation: null,
    pendingGeneration: null,
    deleted: false,
  };
}

describe("archive CFC authorization", () => {
  it("discloses to the owner and an allowed acting reader while restricting writes to the envelope owner", () => {
    const archive = binding();
    expect(authorization.authorize(archive, identity, "read")).toBe(true);
    expect(authorization.authorize(archive, identity, "write")).toBe(true);
    expect(
      authorization.authorize(archive, {
        ...identity,
        principal: "did:key:service",
        actingPrincipal: reader,
      }, "read"),
    ).toBe(true);
    expect(
      authorization.authorize(archive, {
        ...identity,
        principal: "did:key:service",
        actingPrincipal: owner,
      }, "write"),
    ).toBe(false);
    expect(
      authorization.authorize(archive, {
        ...identity,
        actingPrincipal: "did:key:stranger",
      }, "read"),
    ).toBe(false);
    expect(
      authorization.authorize(
        { ...archive, writerPolicy: "another-builtin" },
        identity,
        "read",
      ),
    ).toBe(false);
    expect(
      authorization.authorize(archive, { ...identity, space: reader }, "read"),
    ).toBe(false);
  });

  it("requires every confidentiality clause and rejects missing policy metadata", () => {
    const archive = binding();
    const policy = JSON.parse(archive.cfcPolicy);
    policy.labelMap.entries[0].label.confidentiality.push({
      anyOf: [cfcAtom.user(owner)],
    });
    archive.cfcPolicy = JSON.stringify(policy);
    expect(authorization.authorize(archive, identity, "read")).toBe(true);
    expect(
      authorization.authorize(
        archive,
        { ...identity, actingPrincipal: reader },
        "read",
      ),
    ).toBe(false);
    for (
      const cfcPolicy of [
        "null",
        "{}",
        "invalid",
        JSON.stringify({ ...policy, version: 99 }),
      ]
    ) {
      expect(
        authorization.authorize({ ...archive, cfcPolicy }, identity, "read"),
      ).toBe(false);
    }
  });

  it("checks descendant and opaque-link confidentiality during legacy inspection", () => {
    const metadata = JSON.parse(binding().cfcPolicy);
    expect(authorization.authorizeLegacy!(metadata, identity)).toBe(true);
    for (const observes of ["value", "followRef"]) {
      const restricted = structuredClone(metadata);
      restricted.labelMap.entries.push({
        path: ["raw", "secret"],
        observes,
        label: { confidentiality: [cfcAtom.user(reader)] },
      });
      expect(authorization.authorizeLegacy!(restricted, identity)).toBe(false);
    }
    for (
      const entry of [
        { label: { confidentiality: [] } },
        { path: "raw", label: {} },
        { path: [], label: { integrity: "unreadable" } },
        { path: [], label: [] },
        [],
      ]
    ) {
      expect(
        authorization.authorizeLegacy!({
          ...metadata,
          labelMap: { version: 1, entries: [entry] },
        }, identity),
      ).toBe(false);
    }
    for (
      const value of [undefined, {}, { ...metadata, version: 99 }, {
        ...metadata,
        labelMap: { version: 1, entries: [null] },
      }]
    ) {
      expect(authorization.authorizeLegacy!(value, identity)).toBe(false);
    }
  });
});
