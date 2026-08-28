# LongMemEval retrieval report — hybrid

Dataset: longmemeval_s_cleaned.json @ 98d7416c24c7 | corpus: user-only | embedded: true | pool: 50
Harness: cairn-memory@5.1.0 @ 1f05ad0
Questions: 500 (abstention skipped 30, no-evidence-turn skipped 51)

## official_compat (scored 419, turn-scored 419)

| metric | @5 | @10 |
|---|---|---|
| session recall_all | 0.8783 | 0.957 |
| session ndcg_any | 0.6424 | 0.6428 |
| turn recall_all | 0.6659 | 0.8019 |
| turn ndcg_any | 0.7074 | 0.7424 |

| ability (session recall_all) | scored | @5 | @10 |
|---|---|---|---|
| knowledge-update | 72 | 0.9722 | 0.9861 |
| multi-session | 121 | 0.8017 | 0.9421 |
| single-session-assistant | 5 | 1 | 1 |
| single-session-preference | 30 | 0.9 | 0.9333 |
| single-session-user | 64 | 1 | 1 |
| temporal-reasoning | 127 | 0.8268 | 0.937 |

## unique_session (scored 470, turn-scored 419)

| metric | @5 | @10 |
|---|---|---|
| session recall_all | 0.8702 | 0.9447 |
| session ndcg_any | 0.9041 | 0.9204 |
| turn recall_all | 0.6659 | 0.8019 |
| turn ndcg_any | 0.7004 | 0.7393 |

| ability (session recall_all) | scored | @5 | @10 |
|---|---|---|---|
| knowledge-update | 72 | 0.9722 | 0.9861 |
| multi-session | 121 | 0.8017 | 0.9421 |
| single-session-assistant | 56 | 0.9286 | 0.9643 |
| single-session-preference | 30 | 0.9 | 0.9333 |
| single-session-user | 64 | 1 | 1 |
| temporal-reasoning | 127 | 0.7795 | 0.8898 |
