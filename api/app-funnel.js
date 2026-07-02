// /api/app-funnel.js
// Returns the app-side funnel for users who clicked open_app_click on the webapp
// Funnel steps (all GA4 property 352366632, platform: ANDROID or IOS):
//   first_open → signup_initiate → onboarding_display_name_next →
//   onboarding_username_next → onboarding_done_click → permission_action → home_feed_tab_view
//
// Method: query by pagePath keyword (same as webapp-funnel) but platform != WEB
// All metrics: activeUsers (unique users)

import { BetaAnalyticsDataClient } from '@google-analytics/data';

const WEBAPP_PROPERTY_ID = '352366632';

const APP_FUNNEL_EVENTS = [
  'first_open',
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
  const campaignId = req.query.campaign_id;  // optional: filter to one campaign

  let credentials;
  try {
    credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    return res.status(500).json({ error: 'GA4_SERVICE_ACCOUNT_JSON missing' });
  }

  const client = new BetaAnalyticsDataClient({
    credentials: {
      client_email: credentials.client_email,
      private_key:  credentials.private_key,
    },
  });

  // ── Step 1: get arre_user_ids who clicked open_app_click on webapp ──
  // Platform = WEB, filter by pagePath keyword
  let webRows;
  try {
    const [r] = await client.runReport({
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
    return res.status(500).json({ error: 'GA4 web query failed', detail: e.message });
  }

  // Map each userId → campaignId based on pagePath keyword
  const userCampaignMap = {}; // userId → campaignId
  for (const row of webRows) {
    const pagePath = (row.dimensionValues[0].value || '').toLowerCase();
    const userId   = row.dimensionValues[1].value;
    if (!userId || userId === '(not set)') continue;

    for (const [kw, cid] of Object.entries(PAGE_KEYWORD_MAP)) {
      if (pagePath.includes(kw)) {
        // If a campaignId filter is set, only include that campaign
        if (campaignId && cid !== campaignId) break;
        userCampaignMap[userId] = cid;
        break;
      }
    }
  }

  const userIds         = Object.keys(userCampaignMap);
  const totalAppOpeners = userIds.length;

  if (totalAppOpeners === 0) {
    return res.status(200).json({
      from, to, campaignId: campaignId || 'all',
      app_openers: 0,
      funnel: buildEmptyFunnel(),
      by_campaign: {},
    });
  }

  // ── Step 2: Query app-side events for these userIds ──
  // Platform: ANDROID or IOS, eventName in APP_FUNNEL_EVENTS
  // We filter by customUser:arre_user_id IN (userIds) via IN_LIST filter
  let appRows;
  try {
    const [r] = await client.runReport({
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
            {
              filter: {
                fieldName: 'eventName',
                inListFilter: { values: APP_FUNNEL_EVENTS },
              },
            },
            {
              notExpression: {
                filter: {
                  fieldName: 'platform',
                  stringFilter: { matchType: 'EXACT', value: 'WEB' },
                },
              },
            },
            {
              filter: {
                fieldName: 'customUser:arre_user_id',
                inListFilter: { values: userIds.slice(0, 500) }, // GA4 max filter values
              },
            },
          ],
        },
      },
      limit: 10000,
    });
    appRows = r.rows || [];
  } catch (e) {
    return res.status(500).json({ error: 'GA4 app query failed', detail: e.message });
  }

  // ── Step 3: Tally per-event unique users ──
  // Count distinct userIds per event
  const eventUsers = {}; // eventName → Set of userIds
  const byCampaign = {}; // campaignId → eventName → Set of userIds

  for (const row of appRows) {
    const event    = row.dimensionValues[0].value;
    const userId   = row.dimensionValues[1].value;
    if (!userId || userId === '(not set)') continue;
    if (!userCampaignMap[userId]) continue; // not one of our app openers

    const cid = userCampaignMap[userId];

    if (!eventUsers[event]) eventUsers[event] = new Set();
    eventUsers[event].add(userId);

    if (!byCampaign[cid]) byCampaign[cid] = {};
    if (!byCampaign[cid][event]) byCampaign[cid][event] = new Set();
    byCampaign[cid][event].add(userId);
  }

  // Convert Sets to counts
  const funnelCounts = {};
  for (const evt of APP_FUNNEL_EVENTS) {
    funnelCounts[evt] = eventUsers[evt] ? eventUsers[evt].size : 0;
  }

  const byCampaignCounts = {};
  for (const [cid, events] of Object.entries(byCampaign)) {
    byCampaignCounts[cid] = {};
    for (const evt of APP_FUNNEL_EVENTS) {
      byCampaignCounts[cid][evt] = events[evt] ? events[evt].size : 0;
    }
  }

  return res.status(200).json({
    from,
    to,
    campaignId:  campaignId || 'all',
    app_openers: totalAppOpeners,                 // users who clicked open_app on web
    funnel:      funnelCounts,                    // aggregate across all campaigns
    by_campaign: byCampaignCounts,                // per-campaign breakdown
    event_order: APP_FUNNEL_EVENTS,
  });
}

function buildEmptyFunnel() {
  return Object.fromEntries(APP_FUNNEL_EVENTS.map(e => [e, 0]));
}
