import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubSecrets } from '../src/utils/secret-scanner.js';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';

// Assemble provider-shaped fixtures from fragments so the literal patterns
// never appear contiguously in this file's source — otherwise GitHub push
// protection (and secret scanners) flag the test's own inputs. The joined
// runtime values are identical, so the scanner is exercised exactly.
const f = (...parts: string[]): string => parts.join('');
const AWS_KEY = f('AKIA', 'IOSFODNN7EXAMPLE');
const GH_PAT = f('ghp_', '1234567890abcdefghijklmnopqrstuvwxyz');
const SLACK_TOKEN = f('xoxb-', '2345678901-ABCDEFabcdef');
const STRIPE_KEY = f('sk_', 'live_abcdefghijklmnopqrstuvwx');

describe('scrubSecrets — redacts high-confidence secrets', () => {
  const cases: Array<{ name: string; input: string; mustNotContain: string; mustContain?: string }> = [
    { name: 'AWS access key', input: `key is ${AWS_KEY} here`, mustNotContain: AWS_KEY },
    { name: 'GitHub PAT (ghp_)', input: `token ${GH_PAT} done`, mustNotContain: GH_PAT },
    { name: 'GitHub fine-grained PAT', input: `pat github_pat_${'A'.repeat(60)} end`, mustNotContain: 'github_pat_' + 'A'.repeat(60) },
    { name: 'Slack token', input: SLACK_TOKEN, mustNotContain: SLACK_TOKEN },
    { name: 'Google API key', input: `k AIza${'B'.repeat(35)} k`, mustNotContain: `AIza${'B'.repeat(35)}` },
    { name: 'Stripe secret key', input: STRIPE_KEY, mustNotContain: STRIPE_KEY },
    { name: 'npm token', input: `npm_${'c'.repeat(36)}`, mustNotContain: `npm_${'c'.repeat(36)}` },
    { name: 'OpenAI key', input: `sk-${'D'.repeat(40)}`, mustNotContain: `sk-${'D'.repeat(40)}` },
    { name: 'JWT', input: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36 x', mustNotContain: 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' },
    { name: 'private key block', input: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB\nsecretbytes\n-----END RSA PRIVATE KEY-----', mustNotContain: 'secretbytes' },
    { name: 'PGP private key block', input: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\npgpsecretbytes\n-----END PGP PRIVATE KEY BLOCK-----', mustNotContain: 'pgpsecretbytes' },
    { name: 'OpenAI project key', input: `key sk-proj-${'E'.repeat(48)} end`, mustNotContain: `sk-proj-${'E'.repeat(48)}` },
    { name: 'Bearer token', input: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', mustNotContain: 'abcdefghijklmnopqrstuvwxyz123456' },
  ];

  for (const c of cases) {
    it(`redacts a ${c.name}`, () => {
      const { text, redactions } = scrubSecrets(c.input);
      assert.ok(redactions >= 1, `expected a redaction for ${c.name}`);
      assert.ok(!text.includes(c.mustNotContain), `secret survived: ${text}`);
      assert.match(text, /\[REDACTED:/u);
    });
  }

  it('keeps the URL scheme/host but redacts embedded credentials', () => {
    const { text } = scrubSecrets('connect to postgres://admin:s3cr3tPassw0rd@db.example.com:5432/app');
    assert.ok(!text.includes('s3cr3tPassw0rd'), text);
    assert.ok(text.includes('postgres://'), 'scheme preserved');
    assert.ok(text.includes('@db.example.com'), 'host preserved');
  });

  it('keeps the key and redacts only the value in a secret assignment', () => {
    const { text } = scrubSecrets('password = hunter2hunter2hunter2');
    assert.ok(!text.includes('hunter2hunter2hunter2'), text);
    assert.match(text, /password\s*=\s*\[REDACTED:secret\]/u);
  });

  it('does not over-redact ordinary content', () => {
    for (const ordinary of [
      'Use getUserById to fetch the record',
      'The password field must be validated before submit',
      'set retries = 5 and timeout = 3000',
      'commit a1b2c3d4e5f67890abcdef1234567890abcdef12 fixes the bug',
      'run npm install better-sqlite3 then npm test',
    ]) {
      const { text, redactions } = scrubSecrets(ordinary);
      assert.equal(redactions, 0, `false positive on: ${ordinary}`);
      assert.equal(text, ordinary);
    }
  });

  it('does not redact hyphenated slugs that merely start with sk-', () => {
    for (const slug of [
      'className is sk-button-primary-large-rounded here',
      'the sk-2024-annual-report-final-version-two doc',
    ]) {
      const { text, redactions } = scrubSecrets(slug);
      assert.equal(redactions, 0, `false positive on: ${slug}`);
      assert.equal(text, slug);
    }
  });

  it('does not redact code references in secret-named assignments', () => {
    for (const code of [
      'const client_secret = process.env.CLIENT_SECRET',
      'auth_token = getAuthTokenFromSession()',
      'api_key: identifierWithoutRealSecret',
    ]) {
      const { text, redactions } = scrubSecrets(code);
      assert.equal(redactions, 0, `false positive on: ${code}`);
      assert.equal(text, code);
    }
  });

  it('still redacts a secret-shaped assignment value (digit-bearing)', () => {
    const { text, redactions } = scrubSecrets('api_key: "aB3xK9pQ7mZ2wL5t"');
    assert.equal(redactions, 1);
    assert.ok(!text.includes('aB3xK9pQ7mZ2wL5t'), text);
    assert.match(text, /api_key:\s*"\[REDACTED:secret\]"/u);
  });

  it('is count-idempotent for URL credentials (marker not re-matched)', () => {
    const first = scrubSecrets('db at postgres://admin:s3cr3tPassw0rd@db.example.com:5432/app');
    assert.equal(first.redactions, 1);
    const second = scrubSecrets(first.text);
    assert.equal(second.text, first.text);
    assert.equal(second.redactions, 0);
  });

  it('stays linear on many unterminated private-key headers (no ReDoS)', () => {
    // Bounded lazy body: this returns promptly instead of O(n²) backtracking.
    const adversarial = '-----BEGIN PRIVATE KEY-----'.repeat(10000); // ~270 KB, no END
    const { text, redactions } = scrubSecrets(adversarial);
    assert.equal(redactions, 0, 'no END marker → no key match');
    assert.equal(text, adversarial);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const first = scrubSecrets(`token ${GH_PAT} here`).text;
    const second = scrubSecrets(first);
    assert.equal(second.text, first);
    assert.equal(second.redactions, 0);
  });

  it('counts multiple secrets', () => {
    const { redactions } = scrubSecrets(`a ${AWS_KEY} and npm_` + 'z'.repeat(36));
    assert.equal(redactions, 2);
  });
});

describe('secret scrubbing at the write gateway', () => {
  it('a secret in stored memory content never reaches the database', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const repo = new MemoryRepository(db);
      const { id } = repo.create({
        content: `auth failed with token ${GH_PAT} on deploy`,
        kind: 'pitfall',
        skipDedup: true,
      });
      const stored = repo.findById(id);
      assert.ok(stored, 'memory stored');
      assert.ok(!stored.content.includes(GH_PAT), 'secret redacted before storage');
      assert.match(stored.content, /\[REDACTED:github-token\]/u);
      assert.ok(stored.content.includes('auth failed with token'), 'lesson text preserved');
    } finally {
      db.close();
    }
  });
});
