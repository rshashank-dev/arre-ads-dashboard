// api/sync-ads.js
// Vercel serverless function — called by cron at 1AM IST (19:30 UTC)
// Fetches yesterday's data from Meta Ads API + GA4 Data API, upserts to Supabase

import { createClient } from '@supabase/supabase-js';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// ── Meta Ads Insights ─────────────────────────────────────────────────────────

async function fetchMeta(date) {
  const token     = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;

  const fields = [
    'campaign_id',
    'campaign_name',
    'impressions',
    'reach',
    'clicks',
    'spend',
    'cpc',
    'actions',
  ].join(',');

  const url = `https://graph.facebook.com/v19.0/act_${accountId}/insights` +
    `?fields=${fields}` +
    `&time_range={"since":"${date}","until":"${date}"}` +
    `&level=campaign` +
    `&limit=100` +
    `&access_token=${token}`;

  const res  = await fetch(url);
  const json = await res.json();

  if (json.error) throw new Error(`Meta API error: ${json.error.message}`);

  const rows = (json.data || []).map(r => {
    const landingAction = (r.actions || []).find(a => a.action_type === 'landing_page_view');
    const landings = landingAction ? parseInt(landingAction.value, 10) : 0;

    return {
      sync_date:     date,
      campaign_id:   r.campaign_id,
      campaign_name: r.campaign_name,
      src:           'meta',
      impressions:   parseInt(r.impressions || 0, 10),
      reach:         parseInt(r.reach       || 0, 10),
      clicks:        parseInt(r.clicks      || 0, 10),
      spent:         parseFloat(r.spend     || 0),
      cpc:           parseFloat(r.cpc       || 0),
      landings,
      ga_visitors:   0,
      wa_joins:      0,
    };
  });

  return rows;
}

// ── GA4 Data API ──────────────────────────────────────────────────────────────

async function fetchGA4(date) {
  const propertyId  = process.env.GA4_PROPERTY_ID;
  const credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  const client      = new BetaAnalyticsDataClient({ credentials });

  const startDate = date;
  const endDate   = date;

  // GA4 uses sessionCampaignId which matches Meta campaign_id
  const hostFilter = {
    filter: {
      fieldName: 'hostName',
      stringFilter: { matchType: 'EXACT', value: 'docs-teal-mu.vercel.app' },
    },
  };

  // ── 1. Page view users by sessionCampaignId ──
  const [visitorsResponse] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'sessionCampaignId' }],
    metrics:    [{ name: 'activeUsers' }],
    dimensionFilter: hostFilter,
  });

  // ── 2. WA button click events by sessionCampaignId ──
  const [waResponse] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'sessionCampaignId' }],
    metrics:    [{ name: 'eventCount' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          hostFilter,
          {
            filter: {
              fieldName: 'eventName',
              stringFilter: { matchType: 'EXACT', value: 'click' },
            },
          },
          {
            notExpression: {
              filter: {
                fieldName: 'sessionCampaignId',
                inListFilter: { values: ['(not set)', '(direct)', '(none)'] },
              },
            },
          },
        ],
      },
    },
  });

  // Build maps: campaign_id -> count
  const visitorsMap = {};
  for (const row of visitorsResponse.rows || []) {
    visitorsMap[row.dimensionValues[0].value] = parseInt(row.metricValues[0].value, 10);
  }

  const waMap = {};
  for (const row of waResponse.rows || []) {
    waMap[row.dimensionValues[0].value] = parseInt(row.metricValues[0].value, 10);
  }

  return { visitorsMap, waMap };
}

// ── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const date = req.query.date || yesterday();

  try {
    console.log(`[sync-ads] Syncing date: ${date}`);

    const [metaRows, ga4Data] = await Promise.all([
      fetchMeta(date),
      fetchGA4(date),
    ]);

    const { visitorsMap, waMap } = ga4Data;

    // Join GA4 into Meta rows by campaign_id
    const upsertRows = metaRows.map(row => ({
      ...row,
      ga_visitors: visitorsMap[row.campaign_id] || 0,
      wa_joins:    waMap[row.campaign_id]        || 0,
    }));

    const { error } = await supabase
      .from('ads_campaigns')
      .upsert(upsertRows, { onConflict: 'sync_date,campaign_name,src' });

    if (error) throw new Error(`Supabase upsert error: ${error.message}`);

    console.log(`[sync-ads] Upserted ${upsertRows.length} rows for ${date}`);
    return res.status(200).json({ success: true, date, rows: upsertRows.length });

  } catch (err) {
    console.error('[sync-ads] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
