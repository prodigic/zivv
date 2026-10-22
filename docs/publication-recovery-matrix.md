# Friday publication recovery boundaries

This inventory tracks [#79](https://github.com/prodigic/zivv/issues/79). It describes
implementation evidence, not an activated unattended service. A restored private
checkpoint must never authorize a replacement remote effect merely because its
response or local metadata is missing.

| Boundary                                                        | Evidence retained before the effect                                                                                               | Recovery authority and current limit                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Private source admission and load                               | Journal admission, exact private source bytes, stable source identity and staged worker evidence                                  | Resume the same journal/ledger. The catalog-only encrypted snapshot does not include the source or journal. Restoring older private inputs requires the coherent operator capsule; independently newer private changes are not reconstructed from public control.                                      |
| Public artifact retention                                       | Private immutable claim plan and deterministic public payload                                                                     | Verify the exact immutable artifact ref and fetched payload. Before a canonical claim exists, an unclaimed retained artifact cannot prove that publication was accepted. The ordinary claim path may proceed after complete canonical history proves there was no accepted claim for this run.         |
| Native claim acceptance                                         | Prepared claim, parent, payload receipt and exact timestamp in the private plan; canonical accepted claim and its parent remotely | Reconstruct a missing plan from a unique canonical claim for the private run ID. Verify candidate, source, inventory, original payload ref/receipt and reproduced commit identities. Accepted claims require the existing retained artifact on every retry; a missing ref is never silently recreated. |
| Workflow dispatch                                               | Private dispatch intent and native canonical dispatch-intent, including operation/attempt, workflow pin and nonce                 | Recover the exact original attempt from canonical history, then reconcile with GET requests. Zero or ambiguous matches stay unresolved. Never issue a replacement POST. A claim with no accepted dispatch intent can make its first dispatch.                                                          |
| Native deployment and successful live verification              | Canonical admitted run, deployment and exact verification receipt; private delivery anchor once adopted                           | Existing anchors prove canonical ancestry even after acknowledgement or a later owner. Reconstructing a lost anchor from historical verification and adopting it before the publication path remains a separate implementation step.                                                                   |
| Weekly acknowledgement intent and local publication marker      | Private acknowledgement preimage/afterimage intent plus the canonical acknowledgement digest                                      | Reconstruct a missing pending intent only from complete canonical history and the retained sealed weekly configuration. Digest, original parent, timestamp and candidate bindings must reproduce exactly. No private preimage means no recovery.                                                       |
| Remote acknowledgement completion with stale local weekly state | Canonical completion index and accepted acknowledgement intent, plus bound private preimage/afterimage                            | Under the physical writer lock, repair only the exact old weekly bytes or accept an already published target while preserving legitimate later edits. No second native completion, cutoff movement or catalog mutation. A journal marked succeeded with its artifact missing remains corruption.       |

Canonical history reads are bounded and must report complete evidence. Truncated,
ambiguous, non-canonical, mismatched or inaccessible evidence grants no permission
to publish. Existing public artifacts contain neither raw mail nor the private
catalog, journal, configuration preimages or key; remote publication control does
not replace private recovery storage.

The encrypted [operator capsule](operator-recovery.md) restores a coherent
checkpoint into quarantine. Validated path/runtime admission, old-host fencing
and operational cutover remain tracked in [#78](https://github.com/prodigic/zivv/issues/78).
Authenticated off-machine durability for private state newer than a retained
capsule still needs an explicit installation and retention design. No redundant
remote dispatch-intention store is required where canonical control already
retains the exact accepted intention.

The native Git/SQLite fixtures prove individual boundaries using disposable
repositories and stores. They do not prove a full fresh-machine recovery drill,
credential installation, scheduler restart, independent missing-start alerts, or
two observed Friday releases. Those operational acceptance requirements remain
in the [Friday delivery plan](friday-delivery-plan.md).
