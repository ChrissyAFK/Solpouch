// Operator-only migration. No blockchain writes; never expose as a public endpoint.
import 'dotenv/config';
import { PostgresStore } from '../src/store/postgres.js';
import { validWallet } from '../src/security/auth.js';
const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1];
const id = args.includes('--pouch') ? value('--pouch') : undefined;
const wallet = args.includes('--wallet') ? value('--wallet') : undefined;
if (!id || !wallet || !validWallet(wallet) || !process.env.DATABASE_URL) throw new Error('Set DATABASE_URL and pass --pouch ID --wallet BASE58. Default is dry run; add --apply after checking ownership.');
const store = await PostgresStore.connect(process.env.DATABASE_URL);
try {
  await store.withPouchLock(id, async () => {
    const pouch = await store.getPouch(id);
    if (!pouch) throw new Error('Pouch not found');
    if (pouch.ownerWallet && pouch.ownerWallet !== wallet) throw new Error('This pouch already has a different owner. Reassignment is not supported.');
    console.log(`${args.includes('--apply') ? 'Assigning' : 'Dry run: assign'} pouch ${id} to ${wallet}`);
    if (args.includes('--apply') && !pouch.ownerWallet) await store.savePouch({ ...pouch, ownerWallet: wallet });
  });
} finally { await store.close(); }
