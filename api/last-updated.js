// GET /api/last-updated → { lastUpdated: ISO string | null }
// When fresh data last arrived in this dashboard's database. Read by the SAR Systems Hub for the
// "Updated …" line on this dashboard's card. Returns a single timestamp, no data, so it needs no
// sign-in.
import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI;
const DB  = 'sar-usa-ops';
const DATA_COLLECTIONS = ['usa_ops_jobs', 'usa_ops_etdeta'];

let client;
async function getClient() {
  if (!client) {
    client = new MongoClient(uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 8000 });
    await client.connect();
  }
  return client;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const db = (await getClient()).db(DB);
    // Pushes upsert (api/mongo-batch.js), so each one stamps _meta.lastPush_<collection>.
    const stamps = await db.collection('_meta')
      .find({ _id: { $in: DATA_COLLECTIONS.map((c) => 'lastPush_' + c) } }, { projection: { updatedAt: 1 } })
      .toArray();
    const times = stamps.map((d) => new Date(d.updatedAt).getTime()).filter((t) => !isNaN(t));

    // Before the first stamped push: the newest document's creation time (a lower bound).
    if (!times.length) {
      const newest = await Promise.all(DATA_COLLECTIONS.map((name) =>
        db.collection(name).find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next()));
      newest.forEach((d) => { if (d && d._id && typeof d._id.getTimestamp === 'function') times.push(d._id.getTimestamp().getTime()); });
    }
    return res.status(200).json({ lastUpdated: times.length ? new Date(Math.max(...times)).toISOString() : null });
  } catch (err) {
    console.error('last-updated:', err.message);
    return res.status(500).json({ lastUpdated: null });
  }
}
