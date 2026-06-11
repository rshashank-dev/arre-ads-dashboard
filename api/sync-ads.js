// api/sync-ads.js
// Vercel serverless — called by cron at 1AM IST (19:30 UTC)
// Pulls campaign + adset + ad level data from Meta Ads API and upserts to Supabase

import { createClient } from '@supabase/supabase-js';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── Meta helpers ──────────────────────────────────────────────────────────────

const META_FIELDS = [
  'campaign_id','campaign_name',
  'adset_id','adset_name',
  'ad_id','ad_name',
  'impressions','reach','clicks','spend','cpc','actions',
].join(',');

function parseLandings(actions = []) {
  const a = actions.find(x => x.action_type === 'landing_page_view');
  return a ? parseInt(a.value, 10) : 0;
}

async function fetchMetaLevel(date, level) {
  const token     = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;

  let url = `https://graph.facebook.com/v19.0/act_${accountId}/insights`
    + `?fields=${META_FIELDS}`
    + `&time_range={"since":"${date}","until":"${date}"}`
    + `&level=${level}`
    + `&limit=500`
    + `&access_token=${token}`;

  const rows = [];

  // follow pagination
  while (url) {
    const res  = await fetch(url);
    const json = await res.json();
    if (json.error) throw new Error(`Meta API error (${level}): ${json.error.message}`);
    (json.data || []).forEach(r => rows.push(r));
    url = json.paging?.next || null;
  }

  return rows;
}

// ── GA4 ───────────────────────────────────────────────────────────────────────

async function fetchGA4(date) {
  const propertyId  = process.env.GA4_PROPERTY_ID;
  const credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  const client      = new BetaAnalyticsDataClient({ credentials });

  const hostFilter = {
    filter: {
      fieldName: 'hostName',
      stringFilter: { matchType: 'EXACT', value: 'docs-teal-mu.vercel.app' },
    },
  };

  const [visitorsResp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'sessionCampaignName' }],
    metrics:    [{ name: 'activeUsers' }],
    dimensionFilter: hostFilter,
  });

  const [waResp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'sessionCampaignName' }],
    metrics:    [{ name: 'activeUsers' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          hostFilter,
          { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'click' } } },
          { notExpression: { filter: { fieldName: 'sessionCampaignName',
              inListFilter: { values: ['(not set)','(direct)','(none)','(referral)','(organic)'] } } } },
        ],
      },
    },
  });

  const visitorsMap = {};
  for (const row of visitorsResp.rows || []) {
    const id = row.dimensionValues[0].value;
    visitorsMap[id] = (visitorsMap[id] || 0) + parseInt(row.metricValues[0].value, 10);
  }
  const waMap = {};
  for (const row of waResp.rows || []) {
    const id = row.dimensionValues[0].value;
    waMap[id] = (waMap[id] || 0) + parseInt(row.metricValues[0].value, 10);
  }
  return { visitorsMap, waMap };
}

// ── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const date = req.query.date || yesterday();

  try {
    console.log(`[sync-ads] Syncing date: ${date}`);

    // Fetch all three levels in parallel along with GA4
    const [campaignRows, adsetRows, adRows, ga4Data] = await Promise.all([
      fetchMetaLevel(date, 'campaign'),
      fetchMetaLevel(date, 'adset'),
      fetchMetaLevel(date, 'ad'),
      fetchGA4(date),
    ]);

    const { visitorsMap, waMap } = ga4Data;

    // ── 1. Upsert campaigns ──
    const campaignUpserts = campaignRows.map(r => ({
      sync_date:     date,
      campaign_id:   r.campaign_id,
      campaign_name: r.campaign_name,
      src:           'meta',
      impressions:   parseInt(r.impressions || 0, 10),
      reach:         parseInt(r.reach       || 0, 10),
      clicks:        parseInt(r.clicks      || 0, 10),
      spent:         parseFloat(r.spend     || 0),
      cpc:           parseFloat(r.cpc       || 0),
      landings:      parseLandings(r.actions),
      ga_visitors:   visitorsMap[r.campaign_id] || 0,
      wa_joins:      waMap[r.campaign_id]        || 0,
    }));

    if (campaignUpserts.length > 0) {
      const { error } = await supabase
        .from('ads_campaigns')
        .upsert(campaignUpserts, { onConflict: 'sync_date,campaign_id,src' });
      if (error) throw new Error(`Supabase campaigns upsert: ${error.message}`);
    }

    // ── 2. Upsert adsets ──
    const adsetUpserts = adsetRows.map(r => ({
      sync_date:     date,
      campaign_id:   r.campaign_id,
      campaign_name: r.campaign_name,
      adset_id:      r.adset_id,
      adset_name:    r.adset_name,
      src:           'meta',
      impressions:   parseInt(r.impressions || 0, 10),
      reach:         parseInt(r.reach       || 0, 10),
      clicks:        parseInt(r.clicks      || 0, 10),
      spent:         parseFloat(r.spend     || 0),
      cpc:           parseFloat(r.cpc       || 0),
      landings:      parseLandings(r.actions),
    }));

    if (adsetUpserts.length > 0) {
      const { error } = await supabase
        .from('ads_adsets')
        .upsert(adsetUpserts, { onConflict: 'sync_date,adset_id,src' });
      if (error) throw new Error(`Supabase adsets upsert: ${error.message}`);
    }

    // ── 3. Upsert ads ──
    const adUpserts = adRows.map(r => ({
      sync_date:     date,
      campaign_id:   r.campaign_id,
      campaign_name: r.campaign_name,
      adset_id:      r.adset_id,
      adset_name:    r.adset_name,
      ad_id:         r.ad_id,
      ad_name:       r.ad_name,
      src:           'meta',
      impressions:   parseInt(r.impressions || 0, 10),
      reach:         parseInt(r.reach       || 0, 10),
      clicks:        parseInt(r.clicks      || 0, 10),
      spent:         parseFloat(r.spend     || 0),
      cpc:           parseFloat(r.cpc       || 0),
      landings:      parseLandings(r.actions),
    }));

    if (adUpserts.length > 0) {
      const { error } = await supabase
        .from('ads_ads')
        .upsert(adUpserts, { onConflict: 'sync_date,ad_id,src' });
      if (error) throw new Error(`Supabase ads upsert: ${error.message}`);
    }

    console.log(`[sync-ads] Done: ${campaignUpserts.length} campaigns, ${adsetUpserts.length} adsets, ${adUpserts.length} ads`);
    return res.status(200).json({
      success: true, date,
      campaigns: campaignUpserts.length,
      adsets:    adsetUpserts.length,
      ads:       adUpserts.length,
    });

  } catch (err) {
    console.error('[sync-ads] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
