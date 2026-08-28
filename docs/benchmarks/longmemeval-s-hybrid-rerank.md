# LongMemEval retrieval report — hybrid+rerank

Dataset: longmemeval_s_cleaned.json @ 98d7416c24c7 | corpus: user-only | embedded: true | pool: 50
Reranker: jinaai/jina-reranker-v1-turbo-en (q8, artifact 3defdef1ae34…)
Harness: cairn-memory@5.1.0 @ ba83715
Questions: 500 (abstention skipped 30, no-evidence-turn skipped 51)

## official_compat (scored 419, turn-scored 419)

| metric | @5 | @10 |
|---|---|---|
| session recall_all | 0.8998 | 0.9523 |
| session ndcg_any | 0.6359 | 0.6489 |
| turn recall_all | 0.6516 | 0.821 |
| turn ndcg_any | 0.6857 | 0.7313 |

| ability (session recall_all) | scored | @5 | @10 |
|---|---|---|---|
| knowledge-update | 72 | 0.9722 | 1 |
| multi-session | 121 | 0.8347 | 0.9339 |
| single-session-assistant | 5 | 1 | 1 |
| single-session-preference | 30 | 0.9333 | 0.9667 |
| single-session-user | 64 | 1 | 1 |
| temporal-reasoning | 127 | 0.8583 | 0.9134 |

## unique_session (scored 470, turn-scored 419)

| metric | @5 | @10 |
|---|---|---|
| session recall_all | 0.8894 | 0.9404 |
| session ndcg_any | 0.8897 | 0.9016 |
| turn recall_all | 0.6516 | 0.821 |
| turn ndcg_any | 0.6758 | 0.7261 |

| ability (session recall_all) | scored | @5 | @10 |
|---|---|---|---|
| knowledge-update | 72 | 0.9722 | 1 |
| multi-session | 121 | 0.8264 | 0.9256 |
| single-session-assistant | 56 | 0.9464 | 0.9464 |
| single-session-preference | 30 | 0.9333 | 0.9667 |
| single-session-user | 64 | 1 | 1 |
| temporal-reasoning | 127 | 0.811 | 0.8819 |
