# LongMemEval retrieval report — fts

Dataset: longmemeval_s_cleaned.json @ 98d7416c24c7 | corpus: user-only | embedded: false | pool: 50
Harness: cairn-memory@5.1.0 @ d4a6881
Questions: 500 (abstention skipped 30, no-evidence-turn skipped 51)

## official_compat (scored 419, turn-scored 419)

| metric | @5 | @10 |
|---|---|---|
| session recall_all | 0.7279 | 0.8544 |
| session ndcg_any | 0.4666 | 0.4631 |
| turn recall_all | 0.4749 | 0.6348 |
| turn ndcg_any | 0.5195 | 0.5672 |

| ability (session recall_all) | scored | @5 | @10 |
|---|---|---|---|
| knowledge-update | 72 | 0.9028 | 1 |
| multi-session | 121 | 0.562 | 0.7521 |
| single-session-assistant | 5 | 0.6 | 1 |
| single-session-preference | 30 | 0.5667 | 0.7 |
| single-session-user | 64 | 0.9844 | 1 |
| temporal-reasoning | 127 | 0.7008 | 0.8268 |

## unique_session (scored 470, turn-scored 419)

| metric | @5 | @10 |
|---|---|---|
| session recall_all | 0.7149 | 0.8468 |
| session ndcg_any | 0.7171 | 0.7592 |
| turn recall_all | 0.4749 | 0.6348 |
| turn ndcg_any | 0.5106 | 0.5642 |

| ability (session recall_all) | scored | @5 | @10 |
|---|---|---|---|
| knowledge-update | 72 | 0.9028 | 1 |
| multi-session | 121 | 0.5537 | 0.7438 |
| single-session-assistant | 56 | 0.7321 | 0.8929 |
| single-session-preference | 30 | 0.5667 | 0.7 |
| single-session-user | 64 | 0.9844 | 1 |
| temporal-reasoning | 127 | 0.6535 | 0.7953 |
