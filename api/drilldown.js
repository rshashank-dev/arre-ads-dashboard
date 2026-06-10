// api/drilldown.js
// GET /api/drilldown?campaign_id=XXX&from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns adsets and their child ads for a campaign over a date range

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function agg(rows, groupKey, extraFields = []) {
  const map = {};
  for (const row of rows) {
    const key = row[groupKey];
    if (!map[key]) {
      map[key] = {
        [groupKey]: key,
        ...extraFields.reduce((o, f) => ({ ...o, [f]: row[f] }), {}),
        impressions: 0, reach: 0, clicks: 0, spent: 0, landings: 0,
      };
    }
    const e = map[key];
    e.impressions += row.impressions;
    e.reach       += row.reach;
    e.clicks      += row.clicks;
    e.spent       += parseFloat(row.spent);
    e.landings    += row.landings;
  }
  return Object.values(map).map(r => ({
    ...r,
    spent: +r.spent.toFixed(2),
    cpc:   r.clicks > 0 ? +(r.spent / r.clicks).toFixed(2) : 0,
  })).sort((a, b) => b.spent - a.spent);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { campaign_id, from, to } = req.query;
  if (!campaign_id || !from || !to)
    return res.status(400).json({ error: 'Missing campaign_id, from, or to' });

  try {
    const [{ data: adsetData, error: ae }, { data: adData, error: ade }] = await Promise.all([
      supabase.from('ads_adsets')
        .select('*')
        .eq('campaign_id', campaign_id)
        .gte('sync_date', from)
        .lte('sync_date', to),
      supabase.from('ads_ads')
        .select('*')
        .eq('campaign_id', campaign_id)
        .gte('sync_date', from)
        .lte('sync_date', to),
    ]);

    if (ae)  throw new Error(ae.message);
    if (ade) throw new Error(ade.message);

    const adsets = agg(adsetData, 'adset_id', ['adset_name', 'campaign_id', 'campaign_name']);
    const ads    = agg(adData,    'ad_id',    ['ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name']);

    // Nest ads under their adset
    const adsMap = {};
    for (const ad of ads) {
      if (!adsMap[ad.adset_id]) adsMap[ad.adset_id] = [];
      adsMap[ad.adset_id].push(ad);
    }
    const result = adsets.map(as => ({
      ...as,
      ads: adsMap[as.adset_id] || [],
    }));

    return res.status(200).json({ adsets: result, from, to, campaign_id });

  } catch (err) {
    console.error('[drilldown] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
