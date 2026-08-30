// Standalone owner fixture (M1-exit C3/C4): a SEPARATE PROCESS serving
// the owner RPC over HTTP — the topology the brief names beside owner
// death. The parent test SIGKILLs this process mid-apply.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { openDatabase } from '../../dist/src/db/connection.js';
import { OwnerRpc } from '../../dist/src/mcp/owner-rpc.js';

const [dbPath, portFile] = process.argv.slice(2);
const db = openDatabase({ dbPath });
const rpc = new OwnerRpc({ db });
const server = createServer((req, res) => {
  rpc.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } })
    .catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(portFile, String(server.address().port));
});
