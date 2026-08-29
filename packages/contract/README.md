# cairn-contract

The integration contract for [Cairn](https://github.com/vedtechsolutions/cairn-memory) — types and constants only, zero dependencies.

This package defines the surfaces a client adapter or external integration builds against:

- **Client identity** — the client enumeration and per-client capabilities.
- **Vocabulary** — memory kinds, context modes, and user intents stored in rows and crossing process boundaries.
- **Hook events** — the normalized, discriminated-union hook event payloads.
- **Routes** — the hook-socket route classification.
- **Memory paths** — the memory-path grammar.
- **Round-trip format** — the portable export/import record format.
- **Client adapter** — the adapter registration and lifecycle interfaces.

## Install

```sh
npm install cairn-contract
```

## Usage

```ts
import type { ClientAdapterLifecycle } from 'cairn-contract';
import { CONTEXT_MODES, INTENTS } from 'cairn-contract';
```

## Stability

Everything exported is frozen under an additive-stability guarantee: values may be added, never changed or removed within a major version, and consumers must tolerate unknown values. Versions before `1.0.0` may still see breaking changes.

## License

MIT. The contract is intentionally permissive so adapters and integrations can build against Cairn without restriction; the Cairn runtime itself ([`cairn-memory`](https://www.npmjs.com/package/cairn-memory)) is licensed under the Elastic License 2.0.
