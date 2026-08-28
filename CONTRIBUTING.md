# Contributing to Cairn

Thanks for your interest in improving Cairn. This document covers how to get set up, what we expect from changes, and the contribution terms.

## Getting started

Requirements: Node.js `>= 20`. A C compiler is optional — it builds the fast hook relay, but the install works without one and falls back to a shell relay.

```bash
git clone https://github.com/vedtechsolutions/cairn-memory.git
cd cairn-memory
npm install
npm run build
npm test        # full suite runs on clean in-memory databases
```

Useful checks:

```bash
node dist/src/cli/index.js doctor   # install health check
npm run build && npm test           # build + test in one step
```

## Making changes

- **Match the existing style.** The codebase favors small modules, named constants (no magic values), guard clauses and early returns, and thorough tests. Read the neighbours before adding.
- **Keep changes focused.** One logical change per PR, with a clear description of the *why*.
- **Add tests.** New behavior needs coverage; tests must be independent and runnable in any order.
- **Update docs.** Touch the README and `CHANGELOG.md` when you change setup, config, or user-visible behavior. The changelog follows [Keep a Changelog](https://keepachangelog.com/).
- **Green before review.** `npm run build && npm test` must pass.

## Pull requests

1. Fork and branch from `main`.
2. Make your change with tests.
3. Ensure the build and full suite pass.
4. Open a PR describing the problem and the approach.

## Developer Certificate of Origin

We use the [DCO](https://developercertificate.org/). Sign off each commit with `git commit -s` to certify you wrote the patch or otherwise have the right to submit it under the project license.

## License of contributions

Cairn is licensed under the **Elastic License 2.0** (ELv2). By contributing, you agree that your contributions are licensed under ELv2. Do not submit code you do not have the right to license this way.

## Questions

Open an [issue](https://github.com/vedtechsolutions/cairn-memory/issues) or email **info@vedtechsolutions.com**.
