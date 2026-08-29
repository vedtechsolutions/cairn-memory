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

## Contributor License Agreement (CLA)

Before your first pull request can merge, you must sign the [Cairn Individual CLA](CLA.md). A bot comments on your first PR — reply with the sentence it asks for and the check turns green; the signature covers all your future contributions too.

In short: **you keep the copyright** in your contribution, and you grant VEDTECH Solutions a broad, irrevocable license — including the right to relicense the project under any terms. This is what keeps the project freely relicensable and commercially viable without tracking down every past contributor. Contributing on behalf of a company? Contact **info@vedtechsolutions.com** for a corporate CLA first.

## Developer Certificate of Origin

We also use the [DCO](https://developercertificate.org/). Sign off each commit with `git commit -s` to certify you wrote the patch or otherwise have the right to submit it. The CLA covers what rights you grant; the DCO certifies, per commit, that the code is yours to grant them for.

## Project licenses

The `cairn-memory` runtime is licensed under the **Elastic License 2.0**; the `cairn-contract` package under **MIT**. Your contributions are distributed under the license of the package they land in (and under other terms VEDTECH may choose, per the CLA). Do not submit code you do not have the right to contribute.

## Questions

Open an [issue](https://github.com/vedtechsolutions/cairn-memory/issues) or email **info@vedtechsolutions.com**.
