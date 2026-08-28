import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyCommand } from '../src/hooks/handlers/pitfall-handler.js';

describe('isReadOnlyCommand — classic allowlist', () => {
  const readOnly = [
    'ls',
    'ls -la /tmp',
    'pwd',
    'cat package.json',
    'head -20 file.ts',
    'tail -f log.txt',
    'wc -l src/**/*.ts',
    'echo hello',
    'which node',
    'git status',
    'git log --oneline -10',
    'git diff HEAD~2..HEAD',
    'git show abc123',
    'git branch -a',
    'git rev-parse HEAD',
    'git ls-files src/',
  ];
  for (const cmd of readOnly) {
    it(`treats "${cmd}" as read-only`, () => {
      assert.equal(isReadOnlyCommand(cmd), true);
    });
  }
});

describe('isReadOnlyCommand — expanded investigation commands', () => {
  const readOnly = [
    'grep -l "foo" file.ts',
    'egrep -r "pattern" src/',
    'rg TODO src',
    'ripgrep --type ts "handler"',
    'ag "foo"',
    'fd -e ts',
    'jq ".scripts" package.json',
    'yq eval ".version" pkg.yaml',
    'tree -L 2 src',
    'ps aux',
    'pgrep node',
    'sort file.txt',
    'uniq -c',
    'cut -d, -f1',
    'tr "a" "b"',
    'column -t',
    'xxd binary',
    'od -c file',
    'readlink -f /tmp/x',
    'basename /path/to/file.ts',
    'dirname /path/to/file.ts',
    'lsof -i :8080',
    'tldr curl',
  ];
  for (const cmd of readOnly) {
    it(`treats "${cmd}" as read-only`, () => {
      assert.equal(isReadOnlyCommand(cmd), true);
    });
  }
});

describe('isReadOnlyCommand — language tooling (read-only flags only)', () => {
  const readOnly = [
    'node -v',
    'node --version',
    'npm -v',
    'npm ls',
    'npm list --depth 0',
    'npm view react version',
    'npm outdated',
    'tsc --noEmit',
    'tsc -v',
    'python --version',
    'python3 -V',
    'pip list',
    'pip show requests',
  ];
  for (const cmd of readOnly) {
    it(`treats "${cmd}" as read-only`, () => {
      assert.equal(isReadOnlyCommand(cmd), true);
    });
  }

  const writes = [
    'node -e "require(\'fs\').writeFileSync(\'x\', \'y\')"',
    'node script.js',
    'npm install react',
    'npm run build',
    'npm test',
    'tsc',
    'tsc --watch',
    'python script.py',
    'pip install requests',
  ];
  for (const cmd of writes) {
    it(`treats "${cmd}" as NOT read-only`, () => {
      assert.equal(isReadOnlyCommand(cmd), false);
    });
  }
});

describe('isReadOnlyCommand — sqlite3 special case', () => {
  const readOnly = [
    'sqlite3 cairn.db ".tables"',
    'sqlite3 cairn.db ".schema hook_telemetry"',
    'sqlite3 cairn.db "SELECT * FROM memories LIMIT 5"',
    'sqlite3 ~/.cairn/cairn.db <<EOF\nSELECT count(*) FROM memories;\nEOF',
  ];
  for (const cmd of readOnly) {
    it(`treats "${cmd}" as read-only`, () => {
      assert.equal(isReadOnlyCommand(cmd), true);
    });
  }

  const writes = [
    'sqlite3 cairn.db "INSERT INTO memories VALUES (1)"',
    'sqlite3 cairn.db "UPDATE memories SET confidence = 1"',
    'sqlite3 cairn.db "DELETE FROM memories"',
    'sqlite3 cairn.db "CREATE TABLE t (id INT)"',
    'sqlite3 cairn.db "DROP TABLE memories"',
    'sqlite3 cairn.db "ALTER TABLE memories ADD COLUMN x TEXT"',
    'sqlite3 cairn.db ".import data.csv t"',
  ];
  for (const cmd of writes) {
    it(`treats "${cmd}" as NOT read-only`, () => {
      assert.equal(isReadOnlyCommand(cmd), false);
    });
  }
});

describe('isReadOnlyCommand — find special case', () => {
  const readOnly = [
    'find . -name "*.ts"',
    'find /tmp -type f',
    'find src -mtime -1',
  ];
  for (const cmd of readOnly) {
    it(`treats "${cmd}" as read-only`, () => {
      assert.equal(isReadOnlyCommand(cmd), true);
    });
  }

  const writes = [
    'find . -name "*.tmp" -delete',
    'find . -name "*.log" -exec rm {} \\;',
    'find . -type f -execdir mv {} /tmp \\;',
    'find . -fprint out.txt',
  ];
  for (const cmd of writes) {
    it(`treats "${cmd}" as NOT read-only`, () => {
      assert.equal(isReadOnlyCommand(cmd), false);
    });
  }
});

describe('isReadOnlyCommand — compound commands', () => {
  it('allows && chain of read-only commands', () => {
    assert.equal(isReadOnlyCommand('cd /opt/cairn && ls'), true);
    assert.equal(isReadOnlyCommand('git status && git diff'), true);
    assert.equal(isReadOnlyCommand('ls | grep foo | sort'), true);
  });

  it('rejects compound if ANY part is not read-only', () => {
    assert.equal(isReadOnlyCommand('ls && rm file'), false);
    assert.equal(isReadOnlyCommand('cat file | tee out.txt'), false);
    assert.equal(isReadOnlyCommand('git status ; npm install'), false);
  });

  it('handles env var assignments', () => {
    assert.equal(isReadOnlyCommand('DEBUG=1 ls /tmp'), true);
    assert.equal(isReadOnlyCommand('NODE_ENV=prod node -v'), true);
    assert.equal(isReadOnlyCommand('FOO=bar BAZ=qux git status'), true);
  });

  it('handles leading sudo/time/nice', () => {
    assert.equal(isReadOnlyCommand('sudo ls /root'), true);
    assert.equal(isReadOnlyCommand('time git log'), true);
    assert.equal(isReadOnlyCommand('nice npm ls'), true);
  });
});

describe('isReadOnlyCommand — clearly write commands', () => {
  const writes = [
    'rm file.txt',
    'mv a b',
    'cp a b',
    'mkdir new',
    'touch file',
    'chmod +x script.sh',
    'curl -X POST https://api.example.com',
    'wget https://example.com',
    'git commit -m "x"',
    'git push',
    'git pull',
    'git merge main',
  ];
  for (const cmd of writes) {
    it(`treats "${cmd}" as NOT read-only`, () => {
      assert.equal(isReadOnlyCommand(cmd), false);
    });
  }
});
