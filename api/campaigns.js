// api/campaigns.js
// Dashboard calls GET /api/campaigns?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns aggregated campaign rows for the date range

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // CORS — allow dashboard to call this
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({ error: 'Missing from or to query params' });
  }

  try {
    const { data, error } = await supabase
      .from('ads_campaigns')
      .select('*')
      .gte('sync_date', from)
      .lte('sync_date', to)
      .order('sync_date', { ascending: false });

    if (error) throw new Error(error.message);

    // Aggregate by campaign_name + src across the date range
    const agg = {};
    for (const row of data) {
      const key = `${row.campaign_name}__${row.src}`;
      if (!agg[key]) {
        agg[key] = {
          campaign_name: row.campaign_name,
          src:           row.src,
          impressions:   0,
          reach:         0,
          clicks:        0,
          spent:         0,
          landings:      0,
          ga_visitors:   0,
          wa_joins:      0,
        };
      }
      agg[key].impressions += row.impressions;
      agg[key].reach       += row.reach;
      agg[key].clicks      += row.clicks;
      agg[key].spent       += parseFloat(row.spent);
      agg[key].landings    += row.landings;
      agg[key].ga_visitors += row.ga_visitors;
      agg[key].wa_joins    += row.wa_joins;
    }

    // Compute derived metrics
    // drop rows where campaign had zero activity in this date range
    const rows = Object.values(agg).filter(r =>
      r.impressions > 0 || r.clicks > 0 || r.spent > 0
    ).map(r => ({
      ...r,
      spent:        +r.spent.toFixed(2),
      cpc:          r.clicks   > 0 ? +(r.spent / r.clicks).toFixed(2)      : 0,
      cost_landing: r.landings > 0 ? +(r.spent / r.landings).toFixed(2)    : 0,
      cost_visitor: r.ga_visitors > 0 ? +(r.spent / r.ga_visitors).toFixed(2) : 0,
      cost_wa_join: r.wa_joins > 0 ? +(r.spent / r.wa_joins).toFixed(2)    : 0,
    }));

    // Sort by spent desc
    rows.sort((a, b) => b.spent - a.spent);

    return res.status(200).json({ rows, from, to });

  } catch (err) {
    console.error('[campaigns] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
