# Standalone daemon (multi-agent machines)

Moved from the README front page — same content, same contract.

### 3b. Standalone Daemon (recommended when multiple agents share a machine)

When more than one agent client uses Waykeep on the same machine (for example Claude Code and Codex side by side), run the hook socket as its own service so it survives session churn and no client ever waits on another's lifecycle:

```bash
sudo cp deploy/waykeep-daemon.service /etc/systemd/system/   # adjust paths inside first
sudo systemctl daemon-reload
sudo systemctl enable --now waykeep-daemon
```

After every `npm run build`, restart it to pick up the new code: `sudo systemctl restart waykeep-daemon`. Check it with `curl -s --unix-socket ~/.waykeep/hook-daemon.sock http://localhost/health` — `mode` reports `standalone`. Without the daemon everything still works in embedded mode; sampling-backed hook features (Layer 1c reflection) are only available in embedded mode since the standalone daemon has no MCP client to sample through.

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/waykeep/dist/src/hooks/statusline.js"
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay session-start" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay prompt-check" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay pitfall-check" }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay pitfall-check" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay success-tracker", "async": true }
        ]
      },
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay plan-bridge" }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay error-learning", "async": true }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node /path/to/waykeep/dist/src/hooks/precompact.js" }
        ]
      }
    ],
    "PostCompact": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay postcompact" }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node /path/to/waykeep/dist/src/hooks/session-end.js" }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay subagent-context" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay governance-gate" },
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay stop", "async": true }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay subagent-stop", "async": true }
        ]
      }
    ],
    "StopFailure": [
      {
        "matcher": "rate_limit|max_output_tokens|server_error",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay stop-failure", "async": true }
        ]
      }
    ],
    "FileChanged": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "/path/to/waykeep/dist/src/hooks/hook-relay file-changed", "async": true }
        ]
      }
    ]
  }
}
```

The synchronous `governance-gate` entry must remain before the async `stop`
entry. To disable warn mode or uninstall only the governance relay, remove the
`governance-gate` command and leave the async `stop` entry in place; Waykeep then
returns to advisory-only Slice B behavior.

Or configure Claude Code automatically instead of editing `settings.json` by hand:

```bash
waykeep init            # StatusLine + hooks into ~/.claude/settings.json; MCP server via `claude mcp add-json`
waykeep init --dry-run          # preview the changes without writing
waykeep init --migrate-routes   # modernize deprecated hook routes (one re-trust in Codex)
```

`waykeep init` is idempotent and preserves your existing settings (it backs up
`settings.json` first and never touches non-Waykeep config).

A C compiler is **not** required: the hooks run through the shell relay by
default. For the fast compiled relay, run `waykeep build-relay` where a C
compiler is available (it falls back to the shell relay otherwise). The shell
relay needs a POSIX shell (`bash` + `curl`); on Windows, run `waykeep build-relay`
for the compiled relay, or use WSL. Install paths containing spaces are not
currently supported by the generated hook commands.

