import { MongoClient } from 'mongodb';

const uri    = process.env.MONGO_URI;
const SECRET = process.env.BATCH_SECRET;
const DB     = 'sar-usa-ops';
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hrs

let mongoClient;
async function getClient() {
  if (!mongoClient) {
    mongoClient = new MongoClient(uri, { maxPoolSize: 5, socketTimeoutMS: 45000 });
    await mongoClient.connect();
  }
  return mongoClient;
}

let cache = { data: null, builtAt: null };

async function buildCache(db) {
  console.log('[USA-OPS] Building cache...');
  const expDocs  = await db.collection('usa_ops_export').find({}).toArray();
  const impDocs  = await db.collection('usa_ops_import').find({}).toArray();
  const userDocs = await db.collection('users').find({}).toArray();
  const allDocs  = [...expDocs, ...impDocs];
  console.log(`[USA-OPS] Total docs: ${allDocs.length}, users: ${userDocs.length}`);
  cache = { data: allDocs, users: userDocs, builtAt: new Date().toISOString() };
  return cache;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-batch-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const secret = req.headers['x-batch-secret'];
    if (!secret || secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const { action, records, direction } = req.body;

    if (action === 'wipe') {
      const c  = await getClient();
      const db = c.db(DB);
      const colName = direction === 'Export' ? 'usa_ops_export' : direction === 'Import' ? 'usa_ops_import' : null;
      if (!colName) return res.status(400).json({ error: 'Invalid direction' });
      const result = await db.collection(colName).deleteMany({});
      cache = { data: null, builtAt: null };
      return res.status(200).json({ deleted: result.deletedCount, direction });
    }

    if (action === 'push') {
      if (!records || !records.length) return res.status(400).json({ error: 'No records' });
      const c  = await getClient();
      const db = c.db(DB);
      const colName = direction === 'Export' ? 'usa_ops_export' : 'usa_ops_import';
      const result = await db.collection(colName).insertMany(records, { ordered: false });
      cache = { data: null, builtAt: null };
      return res.status(200).json({ inserted: result.insertedCount, direction });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  if (req.method === 'GET') {
    try {
      const now = new Date();
      if (!cache.data || !cache.builtAt || (now - new Date(cache.builtAt)) > TTL_MS) {
        const c  = await getClient();
        const db = c.db(DB);
        await buildCache(db);
      }
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Age', Math.floor((new Date() - new Date(cache.builtAt)) / 1000));
      return res.status(200).json({ records: cache.data, users: cache.users || [], builtAt: cache.builtAt });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
