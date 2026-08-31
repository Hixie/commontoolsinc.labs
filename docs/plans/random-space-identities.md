# Random Space Identity Implementation Plan

## Status

Proposed one-shot implementation plan. The change lands enabled everywhere and
includes its data migration. It has no feature flag, compatibility mode, or
deprecation phase.

This plan removes the fixed `"common user"` root from space creation. Every new
ordinary space gets a fresh random key pair and therefore a fresh DID. The
creating user's identity becomes the initial owner through the genesis ACL.

The plan uses the DID form defined by
[Common Fabric URLs](../specs/fabric-urls.md). It does not implement DNS
namespaces or a name registry. Those can land independently through the
[space name registry plan](space-name-registry.md). If the registry is absent,
new spaces use DID URLs and Home stores editable display labels.

## Principles

- A space DID comes from fresh cryptographic key data. It does not come from a
  display name, user DID, account DID, or provider hostname.
- Equal labels do not imply equal spaces. Renaming a label does not change a
  space DID.
- The bootstrap private key has one job: authorize the genesis transaction. It
  is destroyed after durable ownership has been established.
- The genesis transaction is the first valid state for the new DID. It assigns
  the creating user as owner before ordinary writes are accepted.
- Repeating a completed create request returns the original result. Repeating a
  new create action creates a different space.
- Browser URLs identify the initial ASP with their hostname and the space with
  its DID. They do not carry a host query parameter.
- This change contains no partial support for future names. Display labels are
  Home metadata and have no resolution semantics.
- Generate at least 256 bits of entropy with the platform cryptographic random
  source. The label, user DID, operation identifier, clock, and process state do
  not contribute key material.
- Do not derive spaces from a user's private key. That would turn user-key
  recovery and rotation into a permanent master-key problem for every space.
- The space DID can authorize one ACL-only genesis transaction at sequence
  zero. After genesis, the space DID has no implicit owner or repair authority.
- Newly created spaces do not receive an ambient `"*": "WRITE"` grant. Their
  first owner is the authenticated creator.

## Connected specifications

- [Common Fabric URLs](../specs/fabric-urls.md) supplies the browser DID form.
  The random identity plan does not define a competing URL or name resolver.
  If the separate registry plan is present, a source ASP can preserve this DID
  URL with a space-move redirect after moving the space to another ASP.
- [Home space and user identity](../common/conventions/HOME_SPACE.md) and
  [Home runtime internals](../features/home-space-internals.md) keep the Home
  space DID equal to the user DID. Its explicit self-owner ACL remains the
  durable authority after genesis.
- [Memory v2 genesis invariants](../specs/memory-v2/09-invariants.md#inv-12--acl-mutation-commit-shape)
  already require the ACL-only first transaction. The
  [current-pass protocol](../specs/memory-v2/04-protocol.md#451-current-pass)
  must lose the conflicting permanent implicit ownership of the space DID.
- [CFC space principals and role membership](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/03-core-concepts.md#36-spaces-and-role-based-confidentiality)
  agree that a space DID is a confidentiality principal whose membership is
  administered.
- [CFC `HasRole` fact generation](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/04-label-representation.md#493-hasrole-fact-generation)
  and the
  [formal membership model](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/formal/Cfc/Membership.lean#L101-L113)
  currently grant membership when the principal equals the space. Preparation
  must amend both so the special case admits genesis without creating permanent
  CFC membership.
- [CFC trusted derived identifiers](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/02-overview.md#24-trusted-derived-identifiers)
  and
  [CFC causal addressing](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/17-addressing-and-storage.md#171-causal-id-storage-core-cfc-path)
  govern replay-stable operation identifiers. Those identifiers select an
  allocation record and never determine key data or authority.
- [Server-side provisioning](../specs/server-side-execution/protocol.md#2b-cross-space-writes)
  and its
  [runtime map](../specs/server-side-execution/runtime-mapping.md) must recover a
  recorded random allocation during replay instead of re-deriving a DID.
- The [FUSE path specification](../specs/fuse-filesystem/2-path-scheme.md),
  [shell routes](../../packages/shell/README.md#routes),
  [navigation guide](../common/patterns/navigation.md), and
  [shared-profile specification](../specs/shared-profile-space.md#profile-space-identity)
  are migration consumers of the explicit create-and-open split.
- [Toolshed storage configuration](../development/CONFIGURATION.md#memory-store)
  does not provide the private allocation record or pending-key protection.
  The implementation adds that control storage explicitly.
- Earlier `ct-space`
  [recovery](https://github.com/commontoolsinc/labs/blob/850bca9aed74c22773de5caa2b0b81c98713e646/docs/access-recovery.md)
  and
  [keyring](https://github.com/commontoolsinc/labs/blob/a98c7444b08a944467171539a1e7baf7082e367d/docs/keyring-architecture.md)
  designs generated fresh space keys but retained them. This plan keeps their
  random allocation boundary and avoids long-term key recovery by removing the
  key's authority after genesis.

## Preparation

- Inventory every production and test path that creates, opens, serializes,
  lists, or schedules work for a space. Include the shell, CLI, runtime,
  PatternFactory, background execution, FUSE, agents, toolshed, fixtures, and
  migration scripts.
- Inventory every use of `"common user"`, `spaceName`, passphrase derivation,
  and assumptions that equal names imply equal DIDs.
- Inventory existing spaces created by deterministic name derivation. Record
  each DID, current owners, ASP, user-facing URLs, Home references, and stored
  cross-space links.
- Confirm that the user-facing named-URL inventory is empty, as expected from
  the stated near-zero-user deployment. Rewrite any unexpected managed links to
  DID URLs and explicitly retire unmanaged legacy names during preparation.
  Do not add a redirect table or make the change depend on the registry plan.
- Prove the exact ACL transaction that grants ownership and the validation rule
  for the first commit of a new DID.
- Land the coordinated CFC specification and formal-model amendment that removes
  permanent membership from `principal === space`. This is a research and
  specification prerequisite, not a runtime phase in the labs pull request.
- Select the existing identity library's secure random key-generation API.
  Confirm that it uses the platform cryptographic random source and emits the
  supported space DID method.
- Define an idempotency key for one user create action. It must survive client
  resubmission and server-process changes without becoming part of the DID.
- Confirm that every production toolshed process shares the durable create
  request store and space storage. Creation must not depend on process-local
  state.

## Changes to make

- Add one space-creation operation shared by every caller.
  - Accept the authenticated creator DID, an opaque idempotency key, the target
    ASP, and optional initial Home display metadata.
  - Generate a fresh random space key pair only when no completed or active
    request exists for that creator and idempotency key. Use at least 256 bits
    of entropy from the platform cryptographic random source.
  - Derive the space DID from the generated public key.
  - Build an ACL-only genesis transaction with no prior version. Grant only the
    creator the owner capability in the ACL representation used by ordinary
    authorization.
  - Sign only that genesis transaction with the space private key.
  - Record the request before submitting genesis. Never report success before
    durable state can reproduce the result.
  - Destroy every in-memory and serialized copy of the private key after
    genesis commits. Do not return it to the shell, store it in Home, or place
    it in logs.
  - Return the space DID, ASP origin, and committed genesis reference.

- Make creation safe across parallel toolshed processes.
  - Store create-request ownership and results in a toolshed-private PostgreSQL
    control table shared by every process for the ASP.
  - Use a unique database constraint on creator DID plus idempotency key so two
    frontend processes cannot generate two accepted results for one action.
  - Store the allocated DID, creation state, and encrypted pending private key
    in the winning transaction. Encrypt pending key data with an
    authenticated-encryption key supplied as a deployment secret.
  - Use explicit `allocated`, `genesis-committed`, and `complete` states. A
    process that receives the same request can resume its recorded state after
    another process exits. It cannot allocate a replacement DID.
  - Ensure a losing concurrent process reads the durable request. It returns a
    completed result or resumes the recorded allocation. It must not publish an
    unused key or genesis transaction.
  - After observing committed genesis, delete the encrypted pending key and mark
    the request complete in one control-database transaction. If a process exits
    between those actions, a later request observes genesis and performs the
    deletion. The key has no post-genesis authority while it awaits deletion.
  - Fence a failed database or storage writer before another writer accepts the
    same request.
  - Use bounded connection pools and request sizes. Apply backpressure when the
    service is saturated.
  - Keep decrypted private key material only in the process performing the
    accepted creation. Do not pass it through queues that persist request
    bodies.

- Narrow the space identity's authorization in the same change.
  - Permit `principal === space DID` only for the ACL-only genesis transaction
    when the space has no ACL and remains at sequence zero.
  - After genesis, evaluate the space DID like any other identity against the
    ACL. Remove every read, write, ACL mutation, CFC membership, and foreign-write
    path that treats equality with the space DID as permanent ownership.
  - Keep configured service authority as its existing explicit policy. It is
    not derived from the space key.
  - Require operator authority or offline storage tooling to repair an invalid
    ownerless ACL. Do not preserve a hidden space-key repair path.
  - Keep Home spaces on the same rule. A Home space remains accessible because
    its genesis ACL explicitly grants its user DID ownership.

- Prepare every existing ACL migration before narrowing authorization.
  - Design a ledger for every populated deterministic space. During cutover,
    populate it from the final authoritative ACL after old writers have drained.
    Include effective owner evidence, Home references, and whether the space DID
    appears as an explicit principal.
  - Derive no owner from knowledge of the old public key. Accept only an owner
    proven by an existing concrete ACL grant or independently authenticated
    account and Home records reviewed by the migration.
  - Plan to install at least one verified concrete owner grant before removing
    implicit space-DID authority.
  - Plan to remove explicit grants to the publicly derivable space DID from
    non-Home spaces. Preserve a Home self-grant because its space DID is the
    user's ordinary identity DID, not a discarded bootstrap identity.
  - Refuse the cutover while any populated space lacks a verified owner. Retire
    an abandoned space explicitly rather than making it inaccessible by
    accident.
  - Define the final ledger verification and durable completion marker that the
    authorization service checks before enabling the narrow rule.

- Replace every ordinary named-space creation path.
  - Change shell creation to call the shared operation and navigate to the
    returned DID.
  - Change CLI creation to call the shared operation and print the returned DID
    and Common Fabric URL.
  - Change `PatternFactory.inSpace()` and `PatternFactory.inSpace(label)` to
    request a fresh space. Treat the optional string as a display label only.
  - Preserve the action's durable event identity as the idempotency key for
    handler post-run creation. A replay of one committed event resolves to the
    same created space.
  - Change background and server-side creation to use the same operation with
    the authenticated initiating identity.
  - Remove public APIs whose only purpose is deriving a space DID from a name.
  - Keep APIs that open an explicit DID. Opening and creating become separate
    operations.

- Make ownership visible immediately after creation.
  - Require all storage, runtime, scheduler, and server authorization paths to
    recognize the genesis ACL before accepting later transactions.
  - Start the default space pattern only after creation returns the committed
    genesis reference.
  - Attribute the default pattern and later writes to the user's delegated
    authority, not to the discarded bootstrap key.
  - Reject a genesis transaction that lacks an owner, has a prior version, or
    grants ownership to a different identity than the authenticated request.
  - Reject a genesis transaction that contains an ordinary data write or a
    wildcard write grant.
  - Reject a second genesis transaction for an existing DID.

- Separate labels from identity throughout Home and user interfaces.
  - Store each known space as its DID, ASP origin, and editable display label.
  - Allow duplicate labels. Use the DID as the list key and navigation target.
  - Keep a renamed label local to Home metadata. It does not rewrite cell
    links, ACLs, stored references, or URLs.
  - Show a shortened DID when no display label exists.
  - Remove any fallback that opens an unknown label by deriving a DID.
  - Make FUSE named paths resolve only through its explicit `.spaces.json`
    mapping. Direct DID paths remain available.

- Use the Common Fabric DID URL subset.
  - Emit `https://<asp-host>/<space-did>` for a space root and
    `https://<asp-host>/<space-did>/<piece-did>` for a piece.
  - Use `https://<asp-host>/` for the authenticated user's home space when the
    application intentionally chooses the specified empty-space spelling.
  - Accept existing piece-slug URLs as user-facing compatibility input and
    replace them with piece-DID URLs after loading.
  - Stop constructing `?host=` and `?spaceHost=` URLs. Keep them as
    user-facing compatibility inputs that validate the ASP origin and redirect
    to the equivalent hostname-based URL.
  - Continue to let higher-priority API, static, and embed routes win before the
    Common Fabric catch-all route.
  - Do not add unregistered friendly-name routing. The separate registry plan
    owns that behavior.
  - Do not implement ASP-to-ASP transfer or space-move redirects in this plan.
    Random space identity remains independently deployable.

- Migrate existing data in the same pull request.
  - Preserve every existing space DID. Random identity creation applies only to
    newly created spaces.
  - Rewrite Home entries and internal metadata that store a name in place of a
    DID so they store the inventoried DID and ASP origin.
  - Rewrite pattern code and fixtures that use a name as an identity. The user
    has explicitly allowed pattern code to migrate without URL-pattern
    compatibility shims.
  - Rewrite repository-owned links and managed Home references to DID URLs.
    Do not install a named redirect table, registry row, or conditional
    integration with the registry plan.
  - Preserve legacy host-query URLs through a validated redirect into
    the Common Fabric hostname form. This compatibility route opens an explicit
    DID and does not restore name-derived creation.
  - Retain old deterministic spaces as ordinary DIDs. Do not rotate their
    identity merely to make their origin random.
  - Remove production code, configuration, and secrets that contain the fixed
    `"common user"` passphrase after all callers and migration inputs have been
    converted.

- Cut over every process and protocol as one compatibility barrier.
  - Provision the shared allocation table without enabling new behavior.
  - Stop accepting new space creation, ACL mutations, and ordinary writes
    globally.
  - Drain every old shell session, toolshed process, storage process, background
    worker, and server-side executor that can derive a named-space key, mutate
    an ACL, write under old authority, or grant permanent space-DID authority.
  - Reject old creation and storage protocol versions after the barrier. Do not
    let an old client reach a new process through another frontend.
  - Take the final authoritative inventory only after old writers are gone.
    Apply the data and ACL migrations, re-read every migrated ACL, and verify
    the completed ledger while the global write barrier remains active.
  - Publish one durable cutover marker only after the migration ledger is
    complete and every old process is gone. New processes refuse ordinary
    reads, writes, and creation until they observe that marker.
  - Resume traffic with random allocation and the narrowed authorization rule
    together. Recovery after activation rolls forward; it does not re-enable an
    old protocol or deterministic creator.

- Update security-sensitive features in the same change.
  - Remove tripwires and disabled states whose only blocker is public named-space
    key derivation after their authorization tests pass with random spaces.
  - Retire credentials or bearer capabilities that were issued while public
    deterministic key material could impersonate a space owner, according to
    each feature's existing retirement procedure.
  - Verify that no code treats knowledge of a display label as authorization.

- Verify identity, replay, routing, and migration behavior.
  - Create two spaces with the same label and prove their DIDs differ.
  - Create spaces with the same label for two users and prove their DIDs differ.
  - Submit one idempotency key through different toolshed processes and prove
    every successful response returns one DID and one genesis reference.
  - Replay a committed handler event and prove it refers to the original new
    space. Trigger a second event with identical inputs and prove it creates a
    different space.
  - Prove the creator owns the space before the first default-pattern write.
  - Prove another identity cannot write without a later delegation.
  - Prove no bootstrap private key remains in databases, Home cells, logs,
    queues, browser storage, or returned values.
  - Prove DID URLs work through every production frontend and identify the same
    ASP without a host query parameter.
  - Prove duplicate and renamed Home labels do not affect resolution.
  - Prove the user-facing named-URL inventory is empty and that the random-only
    result contains no name resolver or name-to-DID redirect table. Test
    host-query compatibility separately.
  - Attempt old protocol versions through every frontend and prove they are
    rejected after the cutover marker.
  - Verify every populated legacy space has a concrete owner and no non-Home
    grant to its publicly derivable space DID.
  - Exercise database and storage failover during creation. Assert that writer
    fencing prevents two accepted results.
  - Run repository formatting, lint, documentation-link, unit, integration,
    browser, ACL, background-execution, and migration checks before landing.

## Result

Every new space has a fresh, unguessable DID backed by random key data. The
creating user owns it from its first committed state. The bootstrap key is then
gone. Display labels remain convenient user metadata, while browser links use
the ASP hostname and space DID prescribed by Common Fabric URLs.
