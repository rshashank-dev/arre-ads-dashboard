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

// Priority order: app_install > lead > landing_page_view
const RESULT_PRIORITY = ['app_install', 'lead', 'landing_page_view'];

function parseResult(actions = []) {
  for (const type of RESULT_PRIORITY) {
    const a = actions.find(x => x.action_type === type);
    if (a && parseInt(a.value, 10) > 0) {
      return { count: parseInt(a.value, 10), type };
    }
  }
  // fallback: landing_page_view even if 0
  const a = actions.find(x => x.action_type === 'landing_page_view');
  return { count: a ? parseInt(a.value, 10) : 0, type: 'landing_page_view' };
}

const RESULT_LABEL = {
  'app_install':      'Installs',
  'lead':             'Leads',
  'landing_page_view':'Landings',
};

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

// PRIMARY WA query — mirrors the "Whatsapp Button Clicks" GA4 report exactly:
// dimension firstUserCampaign, metric activeUsers, filter eventName == 'click'.
// firstUserCampaign is USER-scoped; combining it with an event-scoped eventName
// filter is what the Data API rejects with INVALID_ARGUMENT (the report UI tolerates
// it, runReport does not). We try it anyway — if a future API change accepts it,
// great — and fall back when it throws.
async function fetchWAPrimary(client, propertyId, date) {
  const [resp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'firstUserCampaign' }],
    metrics:    [{ name: 'activeUsers' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          { filter: { fieldName: 'eventName',
                      stringFilter: { matchType: 'EXACT', value: 'click' } } },
          { notExpression: { filter: { fieldName: 'firstUserCampaign',
                      inListFilter: { values: ['(referral)', '(direct)', '(organic)'] } } } },
        ],
      },
    },
  });

  const map = {};
  for (const row of resp.rows || []) {
    const id = row.dimensionValues[0].value;
    if (/^\d+$/.test(id)) map[id] = (map[id] || 0) + parseInt(row.metricValues[0].value, 10);
  }
  return map;
}

// FALLBACK WA query — scope-safe. sessionCampaignName (session-scoped) + eventName
// as a DIMENSION (not a filter), metric eventCount (event-scoped). No cross-scope
// dimensionFilter, so the Data API accepts it. We filter to the 'click' event in JS.
// sessionCampaignName carries the same numeric utm_campaign id as firstUserCampaign
// in this property (that's why the visitors query already joins on it).
async function fetchWAFallback(client, propertyId, date) {
  const [resp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'sessionCampaignName' }, { name: 'eventName' }],
    metrics:    [{ name: 'eventCount' }],
  });

  const map = {};
  for (const row of resp.rows || []) {
    const id        = row.dimensionValues[0].value;
    const eventName = row.dimensionValues[1].value;
    if (eventName !== 'click') continue;
    if (!/^\d+$/.test(id)) continue;
    map[id] = (map[id] || 0) + parseInt(row.metricValues[0].value, 10);
  }
  return map;
}

async function fetchGA4(date) {
  const propertyId  = process.env.GA4_PROPERTY_ID;
  const credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  const client      = new BetaAnalyticsDataClient({ credentials });

  // ── visitors by campaign ──
  const [visitorsResp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'sessionCampaignName' }],
    metrics:    [{ name: 'activeUsers' }],
  });

  const visitorsMap = {};
  for (const row of visitorsResp.rows || []) {
    const id = row.dimensionValues[0].value;
    visitorsMap[id] = (visitorsMap[id] || 0) + parseInt(row.metricValues[0].value, 10);
  }

  // ── WA joins: primary, then scope-safe fallback ──
  let waMap = {};
  let waMethod = 'none';
  let waPrimaryError = null;

  try {
    waMap = await fetchWAPrimary(client, propertyId, date);
    waMethod = 'firstUserCampaign+eventNameFilter';
  } catch (err) {
    waPrimaryError = err.message;
    try {
      waMap = await fetchWAFallback(client, propertyId, date);
      waMethod = 'sessionCampaignName+eventNameDimension(fallback)';
    } catch (err2) {
      waPrimaryError = `${err.message} || fallback: ${err2.message}`;
      waMethod = 'failed';
      waMap = {};
    }
  }

  const ga4_debug = {
    date,
    visitorsKeys: Object.keys(visitorsMap),
    waMethod,
    waPrimaryError,
    waMap,
  };

  console.log('[sync-ads] ga4_debug:', JSON.stringify(ga4_debug));
  return { visitorsMap, waMap, ga4_debug };
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

    const { visitorsMap, waMap, ga4_debug } = ga4Data;

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
      landings:      parseResult(r.actions).count,
      result_type:   parseResult(r.actions).type,
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
      landings:      parseResult(r.actions).count,
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
      landings:      parseResult(r.actions).count,
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
      ga4_debug,   // <- read this from the live endpoint to see exactly what WA returned
    });

  } catch (err) {
    console.error('[sync-ads] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
