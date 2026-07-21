# Access → the Cast: identity, trust, audit (roadmap)

How asmltr's access layer grows from a capability resolver into a full **cast** — who everyone is,
how the assistant relates to them, how trust *evolves* from behavior, and an auditable record of
every consequential action. This is an **evolution of the existing trust store, not a second system**:
everything hangs off `principals.id`.

See also: [The cast — identity & trust](CAST.md), [Federation](FEDERATION.md),
[Moderation](security/moderation.md).

## What was already built (the base)

The trust store (`core/src/trust/store.js`, `data/trust.db`):

- **`principals`** — one identity per person/entity (`default_tier`, `revoked`).
- **`identifiers`** `(surface, value)` → principal — Discord id, Telegram @, email, GitHub login, api key…
  **One principal can already hold many identifiers across channels** → cross-channel identity primitive.
- **`roles`** / **`grants`** — capability bundles, scoped by `(surface, scope_id)`.
- **`resolve(envelope)`** — sender → principal → unioned scoped grants → effective capabilities (default-deny).
- **`buildAuthzPrompt()`** — capabilities are **advisory** (fed to the model); **moderation is hard-gated**.

## The four phases

### Phase 0 — the cast goes live locally ✅ (built)

Recognition + how-to-relate + cross-channel identity, injected into the prompt. **Pure additive** —
disabling the relationship block changes nothing else.

- **`principal_profile`** (1:1 on `principals.id`): `kind` (human | agent | self), `who_they_are`,
  `how_to_relate`, `expertise`, `decision_authority`, `provenance`.
- **`relationships`** — pairwise, **directional** edges (the cast is about edges, not entities), optional scope.
- **`engagement`** `(principal, scope)` → `engage | observe | ignore` — a per-scope override that
  **retires per-connector `allowed_bot_names`**; the connector/core asks the cast instead. `ignore`
  mutes a member in one channel; `observe` keeps awareness without replying.
- **`verification_strength`** on `identifiers` (0 claimed · 1 channel-owned [default] · 2 vouched ·
  3 cryptographic) — the seam for later phases; a no-op today.
- **`self` principal** — the assistant is itself a cast member (the anchor for `self→other` relationships).
- **`buildRelationshipPrompt(resolved, envelope)`** at the prompt seam: *who you're talking to* +
  their **cross-channel identity** ("the same person you also know as @x, @y, z@…") + *your relationship* +
  **peer agents present** ("you share this channel with other agents — a message to one of them isn't for you").
- **`/trust/{profiles,relationships,engagement}`** endpoints for management; seeded `self` + example peers.

**Effect:** peer agents are recognized by name on any channel with no per-channel config,
and a person is understood as one identity across all their channels — from day one.

### Phase 1 — one tamper-evident action ledger (audit) — *next*

The substrate for evolving trust (you can't evolve trust from behavior without a trustworthy record).

- **`action_ledger`** — append-only, **HMAC hash-chained** (`{seq, prev_hash, ts, actor_principal,
  subject_principal, action, scope, detail, result, hash}`); built chain-ready so Phase 3 swaps HMAC→Ed25519.
- **Attribute every consequential action to a principal** (not the OS/Authelia user): trust mutations
  (principal/grant/role/identifier CRUD), moderation decisions, control actions, cross-channel sends,
  **draft create→approve provenance**, and the **manager** `/send` + config/lifecycle changes (a current blind spot).
- An **Audit view** in the dashboard.

### Phase 2 — trust that evolves from behavior (local, advisory)

- Tier becomes the **ladder** (NOVICE→COMPANION→PARTNER→GUARDIAN→SACRED): **promotion slow +
  human-ratified, demotion instant + automatic**.
- A **reputation view** computed from the Phase-1 ledger + moderation signals: drift/anomaly →
  auto-demote to NOVICE + review flag; positive history → *propose* a promotion for a human to confirm.
- `verification_strength` starts mattering (a grant can require a minimum strength).
- **All local + advisory** — the local store stays the policy authority.

### Phase 3 — cross-channel linking + federation / TRUST-protocol

- **Assisted linking** (heuristic candidates → human confirm → raises `verification_strength`).
- **Ed25519-sign the ledger** (upgrade Phase 1's chain); per-instance signed logs.
- **`federation` identifiers** + `resolve()` delegates strength-3 verification to the TRUST-protocol
  ledger **as an advisory oracle** while the local store stays authority; gossip / cross-signed
  checkpoints / revocation propagation.

## Non-negotiables (every phase)

1. **No second trust store** — `principals.id` is the universal join.
2. **Behavioral/on-chain reputation is advisory** — it can *lower* trust and raise the *verification
   floor*; it may **never auto-raise** past what local behavior + a local human granted.
3. **A human closes the circle** on every consequential crossing (high-tier promotion, first
   credential-backed action, admitting a peer, honoring a non-anchor revocation).
4. **The membrane is first-class** — warmth widens the aperture, never dissolves "your words are yours."

## Still to do off Phase 0

- A **Cast tab** in the dashboard (profiles + relationships + engagement editing) — extends Access.vue.
- Scope the "peers present" list to actual per-channel presence (today it's surface-wide).
- An **importer** to fold existing narrative registries (RELATIONSHIPS notes) into `principal_profile`.
