// api/sync-ads.js
// Vercel serverless — called by cron at 1AM IST (19:30 UTC)
// Pulls campaign + adset + ad level data from Meta Ads API and upserts to Supabase

import { createClient } from '@supabase/supabase-js';
import { BetaAnalyticsDataClient } from '@google-analytics/data';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// "Yesterday" in IST (UTC+05:30). The cron fires at 19:30 UTC = 01:00 IST, when the
// server's UTC date is still the previous IST day — using UTC here made every nightly
// run sync the day before yesterday.
function yesterday() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

// Meta "Results" for campaigns optimised on the onboarding_done app event.
// Ads Manager shows this as Results; in the Insights API it comes back inside `actions`
// under an action_type containing "onboarding_done" (e.g. app_custom_event.onboarding_done).
// First match wins, never summed (avoids double-counting roll-up variants).
function parseOnboarding(actions = []) {
  const a = actions.find(x => /onboarding_done/i.test(x.action_type || ''));
  return a
    ? { count: parseInt(a.value, 10) || 0, event: a.action_type }
    : { count: 0, event: null };
}

// ── Meta helpers ──────────────────────────────────────────────────────────────

const META_FIELDS = [
  'campaign_id','campaign_name',
  'adset_id','adset_name',
  'ad_id','ad_name',
  'impressions','reach','clicks','spend','cpc','actions',
].join(',');

// Priority order: app_install > lead > landing_page_view
// NOTE: Meta's Insights API never actually returns an action_type literally named
// "app_install" — for App Installs objective campaigns it returns "mobile_app_install"
// (and sometimes "omni_app_install" as an omnichannel roll-up of the same event).
// Each entry below is a group of raw Meta action_type values that all map to the same
// logical result; first matching value in the group wins (never summed, to avoid
// double-counting roll-up duplicates like omni_*).
const RESULT_GROUPS = [
  { key: 'app_install', metaTypes: ['mobile_app_install', 'omni_app_install', 'app_install'] },
  { key: 'lead',         metaTypes: ['lead'] },
];

function parseResult(actions = []) {
  for (const group of RESULT_GROUPS) {
    for (const metaType of group.metaTypes) {
      const a = actions.find(x => x.action_type === metaType);
      if (a && parseInt(a.value, 10) > 0) {
        return { count: parseInt(a.value, 10), type: group.key };
      }
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

// Meta's own "Results" (what Ads Manager shows, e.g. onboarding_done_click) is NOT in `actions`
// (custom app events are lumped into app_custom_event.other). Newer Graph versions expose it as
// the `results` insights field: [{indicator:'actions:app_custom_event.xxx', values:[{value}]}].
async function fetchMetaResults(date, level, version = 'v21.0') {
  const token     = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  const idField   = level === 'campaign' ? 'campaign_id' : level === 'adset' ? 'adset_id' : 'ad_id';
  let url = `https://graph.facebook.com/${version}/act_${accountId}/insights`
    + `?fields=${idField},results,cost_per_result`
    + `&time_range={"since":"${date}","until":"${date}"}`
    + `&level=${level}&limit=500&access_token=${token}`;
  const map = {};
  const raw = [];
  while (url) {
    const res  = await fetch(url);
    const json = await res.json();
    if (json.error) return { map, raw, error: json.error.message };
    (json.data || []).forEach(r => {
      raw.push(r);
      const v = r.results?.[0];
      const val = v?.values?.[0]?.value;
      if (val !== undefined) map[r[idField]] = { count: parseInt(val, 10) || 0, event: (v.indicator || '').replace(/^actions:/, '') };
    });
    url = json.paging?.next || null;
  }
  return { map, raw, error: null };
}

// ── GA4 ───────────────────────────────────────────────────────────────────────

// WhatsApp joins = users who fired the whatsapp_join_click event, by session campaign
// (the numeric utm_campaign id = Meta campaign id). Mirrors the GA4 exploration:
// rows = event name, filter = session campaign, metric = Active users.
const WA_EVENT = 'whatsapp_join_click';

// PRIMARY WA query — sessionCampaignName + eventName are both accepted together by the
// Data API; filter to the WA event and count activeUsers.
async function fetchWAPrimary(client, propertyId, date) {
  const [resp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'sessionCampaignName' }, { name: 'eventName' }],
    metrics:    [{ name: 'activeUsers' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName',
                stringFilter: { matchType: 'EXACT', value: WA_EVENT } },
    },
  });

  const map = {};
  for (const row of resp.rows || []) {
    const id = row.dimensionValues[0].value;
    if (/^\d+$/.test(id)) map[id] = (map[id] || 0) + parseInt(row.metricValues[0].value, 10);
  }
  return map;
}

// FALLBACK WA query — same dimensions without a server-side filter (filtered in JS),
// in case the filtered request is ever rejected.
async function fetchWAFallback(client, propertyId, date) {
  const [resp] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'sessionCampaignName' }, { name: 'eventName' }],
    metrics:    [{ name: 'activeUsers' }],
  });

  const map = {};
  for (const row of resp.rows || []) {
    const id        = row.dimensionValues[0].value;
    const eventName = row.dimensionValues[1].value;
    if (eventName !== WA_EVENT) continue;
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
    waMethod = 'sessionCampaignName+eventName(filter)';
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

    // ?dry=1 — read-only check: returns every campaign's raw Meta action types + the WA map,
    // writes nothing. Use it to confirm the onboarding_done action name before relying on it.
    if (req.query.dry) {
      const probe = await fetchMetaResults(date, 'campaign');
      return res.status(200).json({
        dry: true, date, ga4_debug,
        results_probe: { error: probe.error, raw: probe.raw },
        campaigns: campaignRows.map(r => ({
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
          spend: r.spend,
          actions: (r.actions || []).map(a => `${a.action_type}:${a.value}`),
          parsed_onboarding: parseOnboarding(r.actions),
        })),
      });
    }

    // ── 1. Upsert campaigns ──
    // meta_debug: campaigns that spent money but resolved to 0 results — usually means
    // Meta returned an action_type this parser doesn't recognize yet. Check
    // meta_debug.zero_result_campaigns in the response before assuming a campaign is
    // genuinely underperforming.
    const meta_debug = { zero_result_campaigns: [] };

    const campaignUpserts = campaignRows.map(r => {
      const result = parseResult(r.actions);
      if (result.count === 0 && parseFloat(r.spend || 0) > 0) {
        meta_debug.zero_result_campaigns.push({
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
          action_types_seen: (r.actions || []).map(a => `${a.action_type}:${a.value}`),
        });
      }
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
        landings:      result.count,
        result_type:   result.type,
        ga_visitors:   visitorsMap[r.campaign_id] || 0,
        wa_joins:      waMap[r.campaign_id]        || 0,
        results:       parseOnboarding(r.actions).count,
        result_event:  parseOnboarding(r.actions).event,
      };
    });

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
      results:       parseOnboarding(r.actions).count,
      result_event:  parseOnboarding(r.actions).event,
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
      results:       parseOnboarding(r.actions).count,
      result_event:  parseOnboarding(r.actions).event,
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
      ga4_debug,    // <- read this from the live endpoint to see exactly what WA returned
      meta_debug,   // <- campaigns with spend but 0 parsed results; check action_types_seen
    });

  } catch (err) {
    console.error('[sync-ads] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
