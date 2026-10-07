import { MongoClient } from 'mongodb';
const uri = process.env.MONGO_URI;
let client;
async function getClient() {
  if (!client) { client = new MongoClient(uri); await client.connect(); }
  return client;
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { action, collection, filter = {}, update, document, documents, limit = 2000, skip = 0 } = req.body;
    const c   = await getClient();
    const db  = c.db('sar-usa-ops');
    const col = db.collection(collection);
    if (action === 'find')      { const docs = await col.find(filter).skip(skip).limit(limit).toArray(); return res.status(200).json({ documents: docs }); }
    if (action === 'findOne')   { const doc  = await col.findOne(filter); return res.status(200).json({ document: doc }); }
    if (action === 'insertOne') { const r = await col.insertOne(document); return res.status(200).json({ insertedId: r.insertedId }); }
    if (action === 'updateOne') { const r = await col.updateOne(filter, update, { upsert: true }); return res.status(200).json({ result: r }); }
    if (action === 'bulkWrite') {
      const ops = documents.map(d => ({ updateOne: { filter: { shipmentId: d.shipmentId }, update: { $set: d }, upsert: true } }));
      const r   = await col.bulkWrite(ops, { ordered: false });
      return res.status(200).json({ result: r });
    }
    if (action === 'deleteMany') { const r = await col.deleteMany(filter); return res.status(200).json({ result: r }); }
    if (action === 'countDocuments') { const n = await col.countDocuments(filter); return res.status(200).json({ count: n }); }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
