// Test A helper: opens the store, inserts a message, marks its delivery
// 'delivering', then hard-kills itself to simulate a crash mid-delivery.
import { openStore } from '../relay/store.ts';

const store = openStore(process.argv[2]);
const msg = store.insertMessage({ source: 'astra', targets: ['codex'], body: 'crash me mid-delivery', hop: 1 });
store.markStatus(msg.id, 'codex', 'delivering');
// No further writes: this process dies with the delivery in flight.
process.kill(process.pid, 'SIGKILL');
