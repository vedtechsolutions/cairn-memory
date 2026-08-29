# waykeep-contract

The integration contract for [Waykeep](https://github.com/vedtechsolutions/waykeep) (formerly Cairn) — types and constants only, zero dependencies.

This package defines the surfaces a client adapter or external integration builds against:

- **Client identity** — the client enumeration and per-client capabilities.
- **Vocabulary** — memory kinds, context modes, and user intents stored in rows and crossing process boundaries.
- **Hook events** — the normalized, discriminated-union hook event payloads.
- **Routes** — the hook-socket route classification.
- **Memory paths** — the memory-path grammar.
- **Round-trip format** — the portable export/import record format.
- **Client adapter** — the adapter registration and lifecycle interfaces.
- **Sync envelope** — the Phase 2 team-sync wire vocabulary: commands, canonical log events, share states, stable error codes, and the entity envelope.

## Install

```sh
npm install waykeep-contract
```

## Usage

```ts
import type { ClientAdapterLifecycle } from 'waykeep-contract';
import { CONTEXT_MODES, INTENTS } from 'waykeep-contract';
```

## Stability

Everything exported is frozen under an additive-stability guarantee: values may be added, never changed or removed within a major version. Unknown-value tolerance is per vocabulary: open sets (memory kinds, client names, sync error codes) require consumers to treat unknown values as valid, while the sync command/event vocabularies are closed replication protocol — an unknown record in a pulled stream is a protocol failure that halts the project, never something to skip. Versions before `1.0.0` may still see breaking changes.

## License

MIT. The contract is intentionally permissive so adapters and integrations can build against Waykeep without restriction; the Waykeep runtime itself ([`waykeep`](https://www.npmjs.com/package/waykeep)) is licensed under the Elastic License 2.0.
