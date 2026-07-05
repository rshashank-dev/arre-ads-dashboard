// /api/app-funnel.js
// Returns the app-side funnel for users who clicked open_app_click on the webapp
//
// PIPELINE (hybrid GA4 + BigQuery, validated 5 Jul 2026):
//   Step 1 (GA4):  open_app_click on webapp → list of arre_user_id
//   Step 2 (BQ):   filter that list to userIds with a native (non-web) appVersion
//                  record in AllUsersV2 — this is the ground-truth "opened app"
//                  signal. Replaces the earlier attempt to use GA4's 'login'
//                  event, which under-counted vs BQ (validated: all users without
//                  a native appVersion record also never fired 'login' — 100%
//                  agreement — but BQ catches slightly more, so BQ is now
//                  the source of truth for this step).
//   Step 3 (GA4):  for that BQ-confirmed cohort, query signup_initiate →
//                  onboarding_display_name_next → onboarding_username_next →
//                  onboarding_done_click → permission_action → home_feed_tab_view
//
// REQUIRES: BQ_SERVICE_ACCOUNT_JSON env var (BigQuery Data Viewer + Job User
// roles on arre-voice-490616) — separate from GA4_SERVICE_ACCOUNT_JSON.

import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { BigQuery } from '@google-cloud/bigquery';

const WEBAPP_PROPERTY_ID = '352366632';
const BQ_PROJECT_ID = 'arre-voice-490616';
const BQ_DATASET    = 'arre_analytics';
const BQ_TABLE      = 'AllUsersV2';

const APP_FUNNEL_EVENTS = [
  'signup_initiate',
  'onboarding_display_name_next',
  'onboarding_username_next',
  'onboarding_done_click',
  'permission_action',
  'home_feed_tab_view',
];

const PAGE_KEYWORD_MAP = {
  'poet':   '6966808714983',
  'singer': '6987389224583',
};

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const from       = req.query.from       || yesterday();
  const to         = req.query.to         || from;
  const campaignId = req.query.campaign_id;

  let ga4Credentials, bqCredentials;
  try {
    ga4Credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    return res.status(500).json({ error: 'GA4_SERVICE_ACCOUNT_JSON missing' });
  }
  try {
    bqCredentials = JSON.parse(process.env.BQ_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    return res.status(500).json({
      error: 'BQ_SERVICE_ACCOUNT_JSON missing or invalid',
      detail: 'This endpoint now needs a BigQuery service account — see header comment for setup.',
    });
  }

  const ga4Client = new BetaAnalyticsDataClient({
    credentials: { client_email: ga4Credentials.client_email, private_key: ga4Credentials.private_key },
  });
  const bigquery = new BigQuery({
    projectId: BQ_PROJECT_ID,
    credentials: { client_email: bqCredentials.client_email, private_key: bqCredentials.private_key },
  });

  // ── Step 1: get arre_user_ids who clicked open_app_click on webapp ──
  let webRows;
  try {
    const [r] = await ga4Client.runReport({
      property:   `properties/${WEBAPP_PROPERTY_ID}`,
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: 'pagePath' },
        { name: 'customUser:arre_user_id' },
      ],
      metrics: [{ name: 'activeUsers' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'open_app_click' } } },
            { filter: { fieldName: 'platform',  stringFilter: { matchType: 'EXACT', value: 'WEB' } } },
          ],
        },
      },
      limit: 5000,
    });
    webRows = r.rows || [];
  } catch (e) {
    return res.status(500).json({ error: 'GA4 web query failed (step 1)', detail: e.message });
  }

  const userCampaignMap = {}; // userId → campaignId
  for (const row of webRows) {
    const pagePath = (row.dimensionValues[0].value || '').toLowerCase();
    const userId   = row.dimensionValues[1].value;
    if (!userId || userId === '(not set)') continue;

    for (const [kw, cid] of Object.entries(PAGE_KEYWORD_MAP)) {
      if (pagePath.includes(kw)) {
        if (campaignId && cid !== campaignId) break;
        userCampaignMap[userId] = cid;
        break;
      }
    }
  }

  const clickedUserIds  = Object.keys(userCampaignMap);
  const clickedCount    = clickedUserIds.length;

  if (clickedCount === 0) {
    return res.status(200).json({
      from, to, campaignId: campaignId || 'all',
      clicked_count: 0, app_openers: 0,
      funnel: buildEmptyFunnel(), by_campaign: {},
    });
  }

  // ── Step 2 (BQ): filter to userIds with a native appVersion record ──
  let openedAppUserIds = [];
  try {
    const [rows] = await bigquery.query({
      query: `
        SELECT DISTINCT userId
        FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\`
        WHERE userId IN UNNEST(@userIds)
          AND NOT STARTS_WITH(COALESCE(appVersion,''), 'web')
          AND appVersion IS NOT NULL
      `,
      params: { userIds: clickedUserIds },
    });
    openedAppUserIds = rows.map(r => r.userId);
  } catch (e) {
    return res.status(500).json({ error: 'BigQuery step 2 failed', detail: e.message });
  }

  const openedAppSet = new Set(openedAppUserIds);
  const appOpeners   = openedAppUserIds.length;

  // Filter userCampaignMap down to only BQ-confirmed app openers
  const openedCampaignMap = {};
  for (const [uid, cid] of Object.entries(userCampaignMap)) {
    if (openedAppSet.has(uid)) openedCampaignMap[uid] = cid;
  }

  if (appOpeners === 0) {
    return res.status(200).json({
      from, to, campaignId: campaignId || 'all',
      clicked_count: clickedCount, app_openers: 0,
      funnel: buildEmptyFunnel(), by_campaign: {},
    });
  }

  // ── Step 3 (GA4): onboarding funnel for BQ-confirmed openers ──
  let appRows;
  try {
    const [r] = await ga4Client.runReport({
      property:   `properties/${WEBAPP_PROPERTY_ID}`,
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: 'eventName' },
        { name: 'customUser:arre_user_id' },
        { name: 'platform' },
      ],
      metrics: [{ name: 'activeUsers' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', inListFilter: { values: APP_FUNNEL_EVENTS } } },
            { notExpression: { filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: 'WEB' } } } },
            { filter: { fieldName: 'customUser:arre_user_id', inListFilter: { values: openedAppUserIds.slice(0, 500) } } },
          ],
        },
      },
      limit: 10000,
    });
    appRows = r.rows || [];
  } catch (e) {
    return res.status(500).json({ error: 'GA4 app query failed (step 3)', detail: e.message });
  }

  const eventUsers = {};
  const byCampaign = {};

  for (const row of appRows) {
    const event  = row.dimensionValues[0].value;
    const userId = row.dimensionValues[1].value;
    if (!userId || userId === '(not set)' || !openedCampaignMap[userId]) continue;

    const cid = openedCampaignMap[userId];

    if (!eventUsers[event]) eventUsers[event] = new Set();
    eventUsers[event].add(userId);

    if (!byCampaign[cid]) byCampaign[cid] = {};
    if (!byCampaign[cid][event]) byCampaign[cid][event] = new Set();
    byCampaign[cid][event].add(userId);
  }

  const funnelCounts = {};
  for (const evt of APP_FUNNEL_EVENTS) {
    funnelCounts[evt] = eventUsers[evt] ? eventUsers[evt].size : 0;
  }

  const byCampaignCounts = {};
  for (const [cid, events] of Object.entries(byCampaign)) {
    byCampaignCounts[cid] = { app_openers: Object.values(openedCampaignMap).filter(c => c === cid).length };
    for (const evt of APP_FUNNEL_EVENTS) {
      byCampaignCounts[cid][evt] = events[evt] ? events[evt].size : 0;
    }
  }

  return res.status(200).json({
    from,
    to,
    campaignId:    campaignId || 'all',
    clicked_count: clickedCount,   // raw GA4 open_app_click, stitched
    app_openers:   appOpeners,     // BQ-confirmed: has native appVersion
    funnel:        funnelCounts,
    by_campaign:   byCampaignCounts,
    event_order:   APP_FUNNEL_EVENTS,
  });
}

function buildEmptyFunnel() {
  return Object.fromEntries(APP_FUNNEL_EVENTS.map(e => [e, 0]));
}
