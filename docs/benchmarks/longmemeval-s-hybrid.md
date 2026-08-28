# LongMemEval retrieval report — hybrid

Dataset: longmemeval_s_cleaned.json @ 98d7416c24c7 | corpus: user-only | embedded: true | pool: 50
Harness: cairn-memory@5.1.0 @ d4a6881
Questions: 500 (abstention skipped 30, no-evidence-turn skipped 51)

## official_compat (scored 419, turn-scored 419)

| metric | @5 | @10 |
|---|---|---|
| session recall_all | 0.8473 | 0.9499 |
| session ndcg_any | 0.6288 | 0.6432 |
| turn recall_all | 0.611 | 0.747 |
| turn ndcg_any | 0.6386 | 0.6761 |

| ability (session recall_all) | scored | @5 | @10 |
|---|---|---|---|
| knowledge-update | 72 | 0.9861 | 1 |
| multi-session | 121 | 0.7273 | 0.9256 |
| single-session-assistant | 5 | 1 | 1 |
| single-session-preference | 30 | 0.8667 | 0.9667 |
| single-session-user | 64 | 1 | 1 |
| temporal-reasoning | 127 | 0.7953 | 0.9134 |

## unique_session (scored 470, turn-scored 419)

| metric | @5 | @10 |
|---|---|---|
| session recall_all | 0.8447 | 0.9362 |
| session ndcg_any | 0.8815 | 0.9016 |
| turn recall_all | 0.611 | 0.747 |
| turn ndcg_any | 0.6311 | 0.673 |

| ability (session recall_all) | scored | @5 | @10 |
|---|---|---|---|
| knowledge-update | 72 | 0.9861 | 1 |
| multi-session | 121 | 0.7273 | 0.9174 |
| single-session-assistant | 56 | 0.9464 | 0.9464 |
| single-session-preference | 30 | 0.8667 | 0.9667 |
| single-session-user | 64 | 1 | 1 |
| temporal-reasoning | 127 | 0.748 | 0.874 |
