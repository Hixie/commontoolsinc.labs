import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { wireAuthorizationOf } from "@commonfabric/memory/v2/session-open-auth";
import { authorizeLoopbackSessionOpen } from "../../src/storage/v2-emulate.ts";
import { createSignedSessionOpenAuth } from "../../src/storage/v2-remote-session.ts";

const signer = await Identity.fromPassphrase("loopback session open signer");
const space = (await Identity.fromPassphrase("loopback session open space"))
  .did() as MemorySpace;
const context = {
  audience: "did:key:z6Mk-loopback-session-open-audience",
  challenge: {
    value: "loopback-session-open-challenge",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  },
};

describe("authorizeLoopbackSessionOpen()", () => {
  it("returns the issuer of a signed open that verifies", async () => {
    const auth = await createSignedSessionOpenAuth(signer, space, {}, context);
    const principal = await authorizeLoopbackSessionOpen(
      { space, session: {}, ...auth },
      context,
    );
    expect(principal).toBe(signer.did());
  });

  it("throws for a signed open whose invocation no longer matches its signature", async () => {
    const auth = await createSignedSessionOpenAuth(signer, space, {}, context);
    const invocation = { ...auth.invocation, iat: 0 };
    await expect(Promise.resolve(authorizeLoopbackSessionOpen(
      { space, session: {}, ...auth, invocation },
      context,
    ))).rejects.toThrow("Invalid signature");
  });

  it("throws for a signed open addressed to a different audience", async () => {
    const auth = await createSignedSessionOpenAuth(signer, space, {}, {
      ...context,
      audience: "did:key:z6Mk-some-other-memory-server",
    });
    await expect(Promise.resolve(authorizeLoopbackSessionOpen(
      { space, session: {}, ...auth },
      context,
    ))).rejects.toThrow("memory session.open audience mismatch");
  });

  it("returns the issuer of a signed open that also names another principal", async () => {
    const other = await Identity.fromPassphrase("loopback session open other");
    const auth = await createSignedSessionOpenAuth(signer, space, {}, context);
    const principal = await authorizeLoopbackSessionOpen(
      {
        space,
        session: {},
        invocation: auth.invocation,
        authorization: {
          signature: wireAuthorizationOf(auth.authorization)?.signature,
          principal: other.did(),
        },
      },
      context,
    );
    expect(principal).toBe(signer.did());
  });

  it("returns the principal an unsigned open names", async () => {
    const principal = await authorizeLoopbackSessionOpen(
      { space, session: {}, authorization: { principal: signer.did() } },
      context,
    );
    expect(principal).toBe(signer.did());
  });

  it("returns `undefined` for an unsigned open that names no principal", async () => {
    const principal = await authorizeLoopbackSessionOpen(
      { space, session: {}, authorization: {} },
      context,
    );
    expect(principal).toBeUndefined();
  });
});
