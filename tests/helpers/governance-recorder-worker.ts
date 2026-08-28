import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/db/connection.js';
import { recordGovernanceEvent } from '../../src/governance/recorder.js';

interface WorkerInput {
  dbPath: string;
  barrier: SharedArrayBuffer;
  input: unknown;
}

const data = workerData as WorkerInput;
const barrier = new Int32Array(data.barrier);
const db = openDatabase({ dbPath: data.dbPath });
parentPort!.postMessage({ ready: true });
Atomics.add(barrier, 0, 1);
Atomics.notify(barrier, 0);
while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0);

try {
  const result = await recordGovernanceEvent(db, data.input);
  parentPort!.postMessage({ result });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : 'unknown error' });
} finally {
  db.close();
}
