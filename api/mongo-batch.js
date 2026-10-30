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
  // usa_ops_jobs replaces the old usa_ops_export/usa_ops_import split - one
  // combined collection now holds every LOB (Sea/Road/Air Export, Sea/Air
  // Import, General, Road Domestic), with a `direction` field on each
  // record (Export/Import, or absent for General/Road Domestic)
  const jobDocs    = await db.collection('usa_ops_jobs').find({}).toArray();
  const userDocs   = await db.collection('users').find({}).toArray();
  const etdEtaDocs = await db.collection('usa_ops_etdeta').find({}).toArray();
  const opsMappingDocs = await db.collection('usa_ops_ops_mapping').find({}).toArray();
  // Pushes upsert in place, so each one stamps _meta.lastPush_<collection>;
  // the newest stamp is when data was last pushed
  const stamps = await db.collection('_meta')
    .find({ _id: { $in: ['lastPush_usa_ops_jobs', 'lastPush_usa_ops_etdeta'] } }).toArray();
  const pushTimes = stamps.map(d => new Date(d.updatedAt).getTime()).filter(t => !isNaN(t));
  console.log(`[USA-OPS] Total docs: ${jobDocs.length}, users: ${userDocs.length}, etdEta: ${etdEtaDocs.length}, opsMapping: ${opsMappingDocs.length}`);
  cache = { data: jobDocs, users: userDocs, etdEta: etdEtaDocs, opsMapping: opsMappingDocs,
            lastSyncAt: pushTimes.length ? new Date(Math.max(...pushTimes)).toISOString() : null,
            builtAt: new Date().toISOString() };
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
      const colName = direction === 'Jobs' ? 'usa_ops_jobs' : direction === 'EtdEta' ? 'usa_ops_etdeta' : direction === 'OpsMapping' ? 'usa_ops_ops_mapping' : null;
      if (!colName) return res.status(400).json({ error: 'Invalid direction' });
      const result = await db.collection(colName).deleteMany({});
      cache = { data: null, builtAt: null };
      return res.status(200).json({ deleted: result.deletedCount, direction });
    }

    if (action === 'push') {
      if (!records || !records.length) return res.status(400).json({ error: 'No records' });
      const c  = await getClient();
      const db = c.db(DB);
      if (direction === 'OpsMapping') {
        // Ops Mapping tab (Job Owner -> Reporting To): wiped first, then inserted as-is
        const result = await db.collection('usa_ops_ops_mapping').insertMany(records, { ordered: false });
        cache = { data: null, builtAt: null };
        return res.status(200).json({ inserted: result.insertedCount, direction });
      }
      const colName = direction === 'Jobs' ? 'usa_ops_jobs' : direction === 'EtdEta' ? 'usa_ops_etdeta' : null;
      if (!colName) return res.status(400).json({ error: 'Invalid direction' });
      // Upsert on a natural key instead of insertMany: a re-run or retry of the
      // same sync batch used to insert duplicate rows every time (insertMany has
      // no notion of "this row already exists"), which is why the dashboard's
      // item counts could run ahead of the sheet. Jobs are one row per shipment;
      // EtdEta is one row per charge line on a shipment, so its key also needs
      // the charge and date to stay unique per line.
      //
      // shipmentId+charge+etdEtaNew is not always unique on its own - a shipment
      // can legitimately have two separate charge lines of the same type at the
      // exact same ETD/ETA New timestamp (confirmed live: SH00041307 had two
      // distinct "TANK TRANSPORTATION CHARGES" lines, $2,511 and $939, same
      // date). A bare upsert on that key silently collapsed them into one,
      // dropping a real line. __seq breaks the tie by position within each
      // repeated key, in the order the sheet sends them, so repeat lines land
      // on separate documents instead of overwriting each other, while an exact
      // re-push of the same batch still lines up seq-for-seq and updates in
      // place rather than duplicating.
      const keyFields = direction === 'Jobs' ? ['shipmentId'] : ['shipmentId', 'charge', 'etdEtaNew'];
      const col = db.collection(colName);
      let ops;
      if (direction === 'Jobs') {
        ops = records.map(r => {
          const filter = {};
          keyFields.forEach(k => { filter[k] = r[k]; });
          return { updateOne: { filter, update: { $set: r }, upsert: true } };
        });
      } else {
        // The sync script sends EtdEta in chunks (500 rows per call), each as its
        // own request - a __seq counter scoped to just this request's `records`
        // resets to 0 every chunk, so two repeat-key rows landing in different
        // chunks both get __seq 1 and the later chunk overwrites the earlier one.
        // Seeding the counter from what's already in the DB for these keys (which
        // includes earlier chunks of the same resync) keeps __seq contiguous
        // across the whole push, not just within one HTTP call.
        const baseKeyOf = r => keyFields.map(k => r[k]).join('\u0001');
        const uniqueKeys = [...new Set(records.map(baseKeyOf))];
        const orFilters = uniqueKeys.map(k => {
          const parts = k.split('\u0001');
          const f = {}; keyFields.forEach((kf, i) => { f[kf] = parts[i]; });
          return f;
        });
        const projection = { __seq: 1 };
        keyFields.forEach(k => { projection[k] = 1; });
        const existing = orFilters.length
          ? await col.find({ $or: orFilters }, { projection }).toArray()
          : [];
        const maxSeq = {};
        existing.forEach(doc => {
          const k = keyFields.map(kf => doc[kf]).join('\u0001');
          maxSeq[k] = Math.max(maxSeq[k] || 0, doc.__seq || 0);
        });
        ops = records.map(r => {
          const k = baseKeyOf(r);
          const seq = (maxSeq[k] = (maxSeq[k] || 0) + 1);
          const filter = {};
          keyFields.forEach(kf => { filter[kf] = r[kf]; });
          filter.__seq = seq;
          const doc = Object.assign({}, r, { __seq: seq });
          return { updateOne: { filter, update: { $set: doc }, upsert: true } };
        });
      }
      const result = await col.bulkWrite(ops, { ordered: false });
      // Upserts keep each document's original _id, so record the push time separately
      // (read by api/last-updated.js for the SAR Systems Hub's dashboard card).
      await db.collection('_meta').updateOne(
        { _id: 'lastPush_' + colName }, { $set: { updatedAt: new Date() } }, { upsert: true });
      cache = { data: null, builtAt: null };
      return res.status(200).json({ upserted: result.upsertedCount, modified: result.modifiedCount, direction });
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
      return res.status(200).json({ records: cache.data, users: cache.users || [], etdEta: cache.etdEta || [], opsMapping: cache.opsMapping || [], lastSyncAt: cache.lastSyncAt || null, builtAt: cache.builtAt });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
