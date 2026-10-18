// Test A helper: a fresh process reopens the database and prints pendingDeliveries().
import { openStore } from '../relay/store.ts';

const store = openStore(process.argv[2]);
console.log(JSON.stringify(store.pendingDeliveries()));
store.close();
