// Operator-only migration. No blockchain writes; never expose as a public endpoint.
import 'dotenv/config';
import { PostgresStore } from '../src/store/postgres.js';
const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1];
const id = args.includes('--pouch') ? value('--pouch') : undefined;
const email = args.includes('--email') ? value('--email')?.trim().toLowerCase() : undefined;
if (!id || !email || !email.includes('@') || !process.env.DATABASE_URL) throw new Error('Set DATABASE_URL and pass --pouch ID --email GOOGLE_EMAIL. Default is dry run; add --apply after checking ownership.');
const store = await PostgresStore.connect(process.env.DATABASE_URL);
try {
  await store.withPouchLock(id, async () => {
    const pouch = await store.getPouch(id);
    if (!pouch) throw new Error('Pouch not found');
    if (pouch.ownerEmail && pouch.ownerEmail !== email) throw new Error('This pouch already has a different owner. Reassignment is not supported.');
    console.log(`${args.includes('--apply') ? 'Assigning' : 'Dry run: assign'} pouch ${id} to ${email}`);
    if (args.includes('--apply') && !pouch.ownerEmail) await store.savePouch({ ...pouch, ownerEmail: email });
  });
} finally { await store.close(); }
