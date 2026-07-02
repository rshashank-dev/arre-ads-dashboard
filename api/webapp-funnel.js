// /api/webapp-funnel.js
// Returns GA4 funnel metrics for WebApp campaigns
// Property: 352366632 (stream G-ENRRL5BHNE)
//
// FIX: Uses pagePath (landing page URL) to match campaigns, NOT sessionCampaignName.
// sessionCampaignName only captures users with UTM params in their session.
// Users landing directly (bookmarks, shares) are missed by that approach.
// pagePath captures ALL users who visited the campaign landing page.
//
// Query params:
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD  (defaults to yesterday)
//
// All metrics use activeUsers (unique users), NOT eventCount.

import { BetaAnalyticsDataClient } from '@google-analytics/data';

const WEBAPP_PROPERTY_ID = '352366632';

// Map: pagePath keyword → campaign_id
// Each campaign has a unique keyword in its landing page URL.
// Add new campaigns here when they are created.
// PAGE_KEYWORD_MAP: keyword in landing page URL → primary campaign_id
// "-2" test variants (52520232218787, 52520231999387) share the same landing pages
// as their primary campaigns, so their traffic is counted in the same bucket.
// Campaign list (active as of Jul 2026):
//   6966808714983  = Tamil Poets Contests  (+ test variant 52520232218787, same page)
//   6987389224583  = Tamil Singers Contest (+ test variant 52520231999387, same page)
//   6985861068183  = Tamil RJ Contest      (offline — no webapp, skipped)
const PAGE_KEYWORD_MAP = {
  'poet':   '6966808714983',  // Tamil Poets Contests
  'singer': '6987389224583',  // Tamil Singers Contest
  // 'rj':  '6985861068183', // Tamil RJ Contest — add URL keyword when confirmed
};

// WA intent = either of these two events
const WA_EVENTS = new Set(['whatsapp_join_click', 'campaign_join_whatsapp_click']);

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const from = req.query.from || yesterday();
  const to   = req.query.to   || from;

  // ── Auth ──
  let credentials;
  try {
    credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    return res.status(500).json({ error: 'GA4_SERVICE_ACCOUNT_JSON missing or invalid' });
  }

  const client = new BetaAnalyticsDataClient({
    credentials: {
      client_email: credentials.client_email,
      private_key:  credentials.private_key,
    },
  });

  // ── Query GA4 ──
  // Dimensions: pagePath + eventName (so we can see which events fired on which page)
  // Metric: activeUsers (unique users)
  // Platform filter: WEB only
  let rawRows;
  try {
    const [response] = await client.runReport({
      property:   `properties/${WEBAPP_PROPERTY_ID}`,
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: 'pagePath' },    // e.g. /contest/poet, /contest/singer
        { name: 'eventName' },
      ],
      metrics: [
        { name: 'activeUsers' },
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'platform',
          stringFilter: { matchType: 'EXACT', value: 'WEB' },
        },
      },
    });
    rawRows = response.rows || [];
  } catch (e) {
    return res.status(500).json({
      error:    'GA4 query failed',
      detail:   e.message,
      property: WEBAPP_PROPERTY_ID,
      from, to,
    });
  }

  // ── Parse rows → campaign buckets ──
  // For each row, check if the pagePath contains any known keyword.
  // Assign to the matching campaign.
  const byCampaign = {};

  for (const row of rawRows) {
    const pagePath = (row.dimensionValues[0].value || '').toLowerCase();
    const event    = row.dimensionValues[1].value;
    const users    = parseInt(row.metricValues[0].value, 10) || 0;

    // Find which campaign this page belongs to
    let campaignId = null;
    for (const [keyword, cid] of Object.entries(PAGE_KEYWORD_MAP)) {
      if (pagePath.includes(keyword)) {
        campaignId = cid;
        break;
      }
    }
    if (!campaignId) continue;

    if (!byCampaign[campaignId]) {
      byCampaign[campaignId] = { landings: 0, pod_plays: 0, wa_intent: 0, app_opens: 0 };
    }

    if (event === 'page_view')           byCampaign[campaignId].landings  += users;
    else if (event === 'pod_play')       byCampaign[campaignId].pod_plays += users;
    else if (WA_EVENTS.has(event))       byCampaign[campaignId].wa_intent += users;
    else if (event === 'open_app_click') byCampaign[campaignId].app_opens += users;
  }

  return res.status(200).json({
    from,
    to,
    property: WEBAPP_PROPERTY_ID,
    method:   'pagePath',  // so we know which approach was used
    funnel:   byCampaign,
  });
}
