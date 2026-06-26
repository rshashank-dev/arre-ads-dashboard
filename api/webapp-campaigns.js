// /api/webapp-campaigns.js
// GET  → returns all enabled campaign IDs from Supabase
// POST → enables a campaign  { campaign_id, campaign_name }
// DELETE → disables a campaign { campaign_id }

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('webapp_campaigns')
      .select('campaign_id, campaign_name')
      .order('enabled_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({
      campaign_ids: (data || []).map(r => r.campaign_id),
      campaigns:    data || []
    });
  }

  if (req.method === 'POST') {
    const { campaign_id, campaign_name } = req.body;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });

    const { error } = await supabase
      .from('webapp_campaigns')
      .upsert({ campaign_id, campaign_name, enabled_at: new Date().toISOString() },
               { onConflict: 'campaign_id' });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, campaign_id });
  }

  if (req.method === 'DELETE') {
    const { campaign_id } = req.body;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });

    const { error } = await supabase
      .from('webapp_campaigns')
      .delete()
      .eq('campaign_id', campaign_id);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, campaign_id });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
