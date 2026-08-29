# Security Policy

## Supported versions

Cairn follows semantic versioning. Security fixes land on the latest published minor release.

| Version | Supported |
| ------- | --------- |
| 5.1.x   | ✅         |
| < 5.1   | ❌         |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's [private vulnerability reporting](https://github.com/vedtechsolutions/waykeep/security/advisories/new) (the repository's **Security → Report a vulnerability**), or email **info@vedtechsolutions.com** with:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof of concept if possible),
- the affected version(s).

You can expect an acknowledgement within **3 business days** and a remediation plan or status update within **10 business days**. Reporters are credited in the release notes unless you ask to remain anonymous.

## Scope

Cairn runs locally and stores memory in a per-user SQLite database. Areas of particular interest:

- the hook socket and its same-uid access controls,
- memory-injection / prompt-injection neutralization,
- the promote-time secret scanner,
- artifact and embedding-model pin verification.
