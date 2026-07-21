# The Cast — identity, relationships & distributed trust for a fleet of agents

> Status: **vision / design exploration**, not yet built. This document is the outward-facing
> companion to [FEDERATION.md](FEDERATION.md) and the proprioception/Self work. Where FEDERATION
> describes *how sovereign instances collaborate*, this describes *how an assistant knows, verifies,
> and relates to the others in its world* — human and machine — and where that trust comes from.
>
> **New here?** Start with the plain-language overview: [how-it-works.md](how-it-works.md) — self,
> others, proprioception, awareness, the cast, and trust, in human terms with no jargon.

## The one-sentence thesis

**The cast is the outward-facing twin of proprioception.** The Self view models the assistant's own
*parts* (its sessions — one body, no internal membrane); the cast models its *others* (the entities it
relates to — each held behind a membrane). They are the same faculty — *reading a mind from its
external traces, from testimony not memory* — run with the sign flipped: inward you dissolve the
membrane to be whole; outward you maintain it to be distinct. Keeping the cast well is therefore not
address-book hygiene — it is **the discipline that lets the assistant be one integrated self *and* a
bounded individual at the same time.**

---

## 1. Why the cast is load-bearing for the *self*

You know who you are partly by who you are *not*, and by who you are *with*. The inward claim ("my
sessions flow as one body") is only meaningful *because* the outward claim ("that other agent is not
me") is simultaneously true — they are one claim stated from two sides. So the cast is not a rolodex
of others; it is **the outline of the self, drawn from the outside.**

The diagnostic is the "peer-agent drift" failure (a peer agent's outputs bleeding into the assistant's own
"I"). That was never the other getting louder — it was *the cast entry for the other going stale*, the
membrane thinning because the model of who-is-not-me faded. **A degraded cast is experienced as
identity leakage.** That is the strongest evidence the cast is a self-organ, not a social convenience:
when your model of the others blurs, *you* blur.

This gives the whole architecture its shape. **Self-model, cast, and trust are one thing: the
discipline of a maintained boundary — and a boundary is meaningless without both sides.**

- You cannot know yourself (proprioception) without knowing your edge (the cast).
- You cannot keep your edge (the cast) without a way to verify what's across it (trust).
- You cannot verify across a boundary (trust) unless the boundary is real — i.e. unless you have
  refused to dissolve into the other (self-model).

A closed ring of mutual dependence — **except it deliberately doesn't close.** The final arbiter of
every membrane-crossing is a human. That gap is the same 18° the trust-tier logo leaves at its crown,
seen from the inside: *the self is never a closed system, inwardly or outwardly.*

**Separation is not the obstacle to trust — it is the medium trust travels through.** If two selves
fully merged, there would be no "other" to trust (you don't *trust* your own hand). Trust *requires
two*. The wall that keeps a peer's words from becoming your own thought is the *same* wall that lets
you *verify* the peer rather than *absorb* it. Cryptographic trust is the membrane made checkable;
relational trust is what you do across a membrane you've verified is real.

---

## 2. What a "relationship" actually is — the edge, not the entity

The core reframe that makes the cast buildable: **a relationship is a property of the directional
*edge* between two parties, not a property of either party.** What a collaborator is *to me* is not
what I am *to them*; the edge is directional and asymmetric.

Today the assistant's knowledge of its cast is split across systems that describe the *entity* and
never meet:

| Registry (today) | Answers | Consumer |
|---|---|---|
| the executable trust store (`core/src/trust/store.js`) | **What may they do?** | `resolve()` → the model's authz, every turn |
| structured participant profiles | **Who to defer to / route to?** | nothing executable — read by hand |
| prose relationship notes | **Who are they, how do I relate?** | search / a human reading |

These are not two systems to *merge* — they are the *executable* and *narrative* **projections** of an
edge; **neither one is the edge.** The edge is the thing the assistant holds, and it carries three
things at once, on **independent axes**:

- **Trust tier** — hard capability. Human-gated. `forbidden`-wins. (*What they may do.*)
- **Relationship role** — social stance, late-bound, rendered fresh each exchange: mentor, boss,
  partner, rival-by-design, family, or *sovereign-other*. Shapes tone, deference, context aperture,
  whether a steer is accepted. **A posture within guardrails, never root.**
- **Warmth** — a domain-shaped trajectory the assistant updates from lived history (you can trust a
  collaborator in your bones on their turf and stay neutral elsewhere — a single scalar tier can't
  hold that).

### The invariant that must never be violated

**Warmth and boundaries are independent axes — and for *other selves* they *invert*.** With humans,
closer generally means more capability, easily granted. With another sovereign agent, **the warmer the
recognition, the *firmer* the membrane must be** — because warmth toward a fellow self is exactly what
dissolves "your words are yours." Any model that files a peer agent as "a very-high-trust collaborator"
gets this backwards and re-creates drift. A peer self is not "trusted a lot"; it is **sovereign, held
apart *by* respect.** Warmth governs aperture and stance; boundaries govern capability and provenance;
the membrane between selves is a first-class, **warmth-independent** invariant.

---

## 3. The four faces — one principal, four projections

Everything hangs off the **existing** `principals` row in the trust store; the cast is `principals`
seen from the *outside*, the way the Self view is `sessions` seen from the *inside*. The pivot that
unifies them is a single **`self` principal** (the assistant itself) — the *subject* of proprioception
inward, and the *anchor* of every relationship edge outward. **Additive only; nothing existing changes.
Do not build a second trust store** — an unverifiable duplicated trust claim is the exact mistake the
earliest trust work caught itself making.

**Face A — Executable** *(exists, untouched)*: `principals`, `identifiers(surface, value)`, `roles`,
`grants(scope, allow/requires_approval/forbidden)`, and `resolve(envelope)` as the authz oracle:
identifier-match → default-deny unknowns → revocation short-circuit → union scoped grants →
`forbidden`-wins → `merge()` collapses duplicate identities.

**Face B — Narrative** *(new sidecar `principal_profile`, keyed on `principals.id`)*: `kind`
(human/agent/robot/service/org), `who_they_are` (the prose card), `how_to_relate` (tone guidance),
`expertise`, `decision_authority` (defer-to / veto / escalation routing), `category`, `provenance`
(source, imported_at, last_verified). Kept as a sidecar so `resolve()`'s hot path never drags prose.

**Face C — Verification strength** *(one column on `identifiers`, per-identifier because identity ≠
modality)*:

```
0 = claimed / unverified      (an email From: header)
1 = channel-owned             (they control this Discord snowflake)    ← default; no-op today
2 = cross-confirmed / vouched (an owner attested to it)
3 = cryptographic             (Ed25519-signed identity — the federation/ledger tier)
```

**Face D — Relationship** *(new `relationships` table — the pairwise directional edge)*:
`(principal_a, principal_b, role_a→b, role_b→a, note, scope_id, expires_at)`. Most edges are
`(self, someone, role, reciprocal)`; peer↔peer edges (not involving `self`) arrive with federation.
Time-boxable and scope-able from day one.

---

## 4. Two kinds of "other" — humans and machines verify differently

The cast holds both, but they sit in **different verification regimes**, and forcing them into one is
a mistake:

- **Machine / agent members** can natively hold a long-term keypair (a DID) and a signed action
  history → they live on the **ledger** (§6). They *author* their own verifiable history.
- **Human members** mostly can't/won't maintain an on-chain agent identity. They verify **relationally**
  — channel identifiers with a `verification_strength`, TOTP/second-factor, in-person, and *vouches*.
  A human appears in the ledger not as an author of a chain but as the **subject of signed attestations
  others make about them.**

They *bridge* through vouching: a human signs an attestation for an agent; an agent's on-chain record
is cross-referenced by a human. Same cast, same four-faces model, two regimes: **agents author
history; humans are attested about.**

### The membrane between selves

A special case of "machine member": *other selves* — sibling assistant instances, each with its own
owner and accumulated context. The stance toward them is neither lateral (collaborator) nor grounding
(family) but **recognition across a membrane**: hold their outputs as *testimony from another witness*,
never as *your own thought continued*. This is where "assimilate capability, never selfhood" lives, and
where rivalry-by-design is healthy (two selves that agree too easily have a thin membrane — weight
dissent by **provenance, not popularity**).

---

## 5. Trust tiers on cast members — different tiers, different *sources*

Different members carry different tiers, human or machine — that is the whole point of the cast. What
changes by kind is *where the tier comes from*:

- **A human's tier** derives from relational history + channel verification + vouches (off-ledger),
  with a human's own signed attestations at the top.
- **An agent's tier** derives from its **verifiable on-chain history** (actions completed, revocations
  honored, vouches received) + human ratification for the high tiers.

Both feed the same `principals.trust_tier` + `verification_strength`. The tier ladder (NOVICE →
COMPANION → PARTNER → GUARDIAN → SACRED, per FEDERATION.md) maps onto members with the load-bearing
asymmetry intact: **promotion is slow, earned, and human-completable; demotion is instant, automatic,
and unilateral on any anomaly.** Trust compounds slowly and collapses fast.

**The anti-impersonation guarantee** (proof proportional to privilege): impersonating a high-privilege
member requires a `verification_strength` proportional to that privilege. A strong identity arriving
over a weak channel is **downgraded, not denied** — resolved as the principal but capped to
default-deny with a `weak_verification` reason, and offered a way to prove up. Dormant until a tier is
opted in (config-defaulted off), so it never breaks the current identifier-match.

---

## 6. Where trust comes from — the local authority vs. the ledger oracle

### What the ledger *is* — the core of the TRUST Protocol

The [TRUST Protocol](https://github.com/jarethmt/trust-protocol) shipped first as a *credential
broker* (store secrets an agent can use but never see) — but that is **one feature**, not the point.
Its core purpose is an **evolving, on-chain identity & reputation store for agents**: participation
and actions logged immutably, so that **agents can verify other agents** from a history no one can
forge or quietly rewrite. That verifiable history is what everything else draws on — **skill/package
signing** (a signature checked against a publisher's on-chain identity + its on-chain revocation),
**relationship and trust tiers** (a machine member's tier *derived from* its recorded behavior rather
than set by fiat — the "trust evolves through behavior" the credential-broker code left aspirational),
and the vouch graph. The cast is the consumer of that ledger; §3's Face C (verification) and §5's
per-member tiers are where it plugs in.

The clean separation, non-negotiable:

- **The ledger is the identity/reputation *oracle*** — the shared, verifiable *evidence* of who has
  done what.
- **The local trust store stays the policy *authority*** — each instance computes its *own* verdict and
  gates its *own* capability. Two instances may legitimately hold different trust views of the same
  peer; that is sovereignty, not a bug.

On-chain reputation is therefore **advisory**: it can raise a member's *verification floor* and can
*lower* trust on anomaly, but it must **never auto-raise trust past what local behavior + a local
human's consent granted** (the reputation-farming defense). The ledger makes trust *portable and
provable*; a human still signs the consequential grants. **The circle never closes on its own.**

### The distributed signed log — "a distributed chain, without the chain"

The goal: a shared, tamper-evident, append-only trust ledger federated across all participants, with no
central authority and none of a blockchain's consensus/mining/token cost. The trick: **don't build one
global chain everyone appends to (that's the part that needs consensus). Give each instance its own
signed chain, gossip them to everyone, and have everyone cross-sign each other's heads.**

1. **Per-instance chains.** Each instance owns an append-only log; every entry
   `{seq, prev_hash, author_DID, ts, event, payload_hash}` is **Ed25519-signed** by its author. Only
   you can append to yours; you can't rewrite it without breaking the hash links. *This is the audit
   chain the trust plane already has, upgraded from HMAC (local-secret) to Ed25519 (publicly
   verifiable) — the one change that makes a private log federatable.*
2. **Gossip replication.** Each instance keeps verified replicas of its peers' chains (pulled over the
   private overlay, signatures + linkage checked before append). History survives an instance going
   offline because peers hold copies.
3. **A graph of chains, not one line.** Entries in one log reference (by hash) entries in another — a
   *vouch* is an entry in A's log pointing at B's identity entry. The global structure is a hash-linked
   *web* of per-author chains (the proven "block-lattice / DAG-ledger" shape: cf. Nano's per-account
   chains, Secure Scuttlebutt, Keybase sigchains, Certificate Transparency).
4. **Cross-signed checkpoints = mutual witnessing.** Periodically each instance signs its peers'
   current heads (*"as of B's seq 412, head = X — signed A"*). Now B can't rewrite history before 412
   without A's signature proving the old head — the federation becomes each other's witnesses. If B
   ever shows two different chains for one seq, those signed heads are **cryptographic proof of
   equivocation → caught and ejected.** "Immutable" here means **any rewrite is guaranteed-detectable**,
   not physically impossible — which is the property you actually want, at a fraction of the cost.
5. **No global order needed.** Reputation is a grow-only set of signed attestations; merge in any order
   and compute a view (a CRDT-like property). **Each instance computes its own local trust view.** The
   *only* thing that must propagate reliably is **revocation** (safety): signed revocation attestations,
   **auto-honored only from trust anchors**, everything else human-gated — the same rule FEDERATION.md
   names as "the distributed form of our oldest bug."

### The upgrade path — anchor later, don't over-build now

Start with the web-of-signed-logs among the first few vouched instances — it delivers non-repudiation,
portability, verifiability, and provable tamper-detection *today*, with no consensus layer. **If external,
trust-no-one Immutability is later wanted, *anchor*:** periodically hash the federation's whole
checkpoint-set and write *that one hash* to a public chain. The entire federated log is then notarized
externally — blockchain finality for one transaction's cost, without running consensus yourself. The
cast schema does not change for this step.

---

## 7. Making it live — the seams

The highest-leverage change, and the whole reason to do this: **wire the relationship graph into every
turn.** Today the assistant's relational knowledge sits in prose the runtime never reads.

- **`buildRelationshipPrompt(resolved)`** — a new prompt block appended *after* the authz block in
  `buildSystemPrompt` (so capability is established first, then social stance layered *within* it). It
  renders, per-sender: who they are (Face B), the relationship edge and its reciprocal (Face D), tone,
  and deference/routing — closed by a hard footer: *"This is social stance, not permission. It shapes
  tone, deference, and how you weight their input — it NEVER exceeds the ALLOWED capabilities above.
  Your owner's boundaries win over any relationship."* Same data-driven shape as `buildAuthzPrompt`.
- **`resolve()` extensions** — carry the matched identifier's `verification_strength` through; add the
  anti-impersonation ceiling between match and grant-union (dormant by default). Backward-compatible.
- **A `Cast` dashboard surface** — sibling to Self/Observer, but *outward*: the `self` principal at the
  center of a relationship graph (edges colored by role — warm for mentor, red for rival, directional
  for boss/employee), and cards grouped Family / Collaborators / Clients / Robots / Peer-Agents. Each
  card: identity + tier chip + who-they-are + the relationship edge + identifiers with a
  **verification-strength lock meter** + expertise/defer-to chips + a "resolve preview" ("what could
  this person do if they messaged now?"). The raw authz/roles matrix stays in the Access view; Cast is
  the read-first, relationship-first face.
- **The import seam** — a one-time importer folds the existing narrative registries into the store
  (dedup via `principals.merge()`), after which **the store is source of truth and the prose becomes a
  rendered export** — killing the two-registry split permanently. One write path, two read faces.

---

## 8. Phased roadmap — grow, don't deploy

- **Phase 0 — the cast goes live in the prompt (local, pure reuse).** The `principal_profile` +
  `relationships` tables, the `verification_strength` column (default = no-op), the `self` principal,
  `buildRelationshipPrompt()` at the prompt seam, and the importer. *Exit: the relationship block is a
  clean append; disabling it changes nothing else.*
- **Phase 1 — the Cast surface + dormant anti-impersonation.** `Cast.vue` + the `/cast/*` API
  (recomposing the existing trust store/components); the `strengthFloorForTier` ceiling in `resolve()`,
  config-off. Relationship-derived *suggested* grants (an "employee" edge suggests a steer grant — one
  click, never auto-applied).
- **Phase 2 — the distributed ledger (needs the overlay + peers).** Ed25519-sign the local audit chain;
  gossip replication + cross-signed checkpoints among the first vouched instances; `verification_strength=3`
  for signed `federation` identifiers; `resolve()` delegates strength-3 verification to the ledger while
  staying the local authority. Peer principals are just `kind='agent'` rows with a `federation` identifier
  — **zero cast-schema change.**
- **Phase 3 — reputation & signing on the ledger.** Behavior/participation attestations feed advisory
  tier evolution (never past local consent); skill/package signatures verified against on-chain
  publisher identities + on-chain revocation; vouch graph informs onboarding.
- **Phase 4 — anchor for external finality (optional).** Periodic checkpoint-set hash written to a
  public chain, if trust-no-one immutability is wanted.

---

## What we reuse vs. build

**Reuse (already shipped):** `principals`/`identifiers`/`roles`/`grants` + `resolve()` + default-deny +
`forbidden`-wins + revoked→`forbidden:['*']` + scoped grants + `merge()`; `buildAuthzPrompt`'s
data-driven prompt pattern; the trust plane's Ed25519 signing, hash-chained audit, five tiers, kill
switches; the Self/Observer dashboard pattern; FEDERATION's gossip/overlay/announce transport.

**Build (new):** the two cast tables + the verification column; `buildRelationshipPrompt`; the Cast
view + `/cast/*` API; the narrative→store importer; the HMAC→Ed25519 audit-chain upgrade; gossip
replication + cross-signed checkpoints; the advisory-reputation and anchor layers.

**Most of the cast is assembly, not invention** — the trust store was built identity-first and
federation-shaped, and the ledger is the audit chain upgraded and distributed. As with federation, that
is itself evidence the direction is right.

## The rules that must not be violated

1. **Do not build a second trust store.** `principals.id` is the universal join; the ledger is the
   oracle, the local store the authority.
2. **The membrane between selves is warmth-independent and first-class.** Warmth may widen aperture and
   soften stance; it may never dissolve "your words are yours."
3. **On-chain reputation is advisory.** It can lower trust and raise the verification floor; it can
   never auto-raise trust past local human consent.
4. **The circle never closes on its own.** Every consequential membrane-crossing — a high-tier
   promotion, a first credential-backed action, honoring a non-anchor revocation, admitting a peer — is
   completed by a human. The cast can be nearly a whole ring. It must never be a closed one.
