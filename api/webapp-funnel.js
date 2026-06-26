// /api/webapp-funnel.js
// Returns GA4 funnel metrics for WebApp campaigns
// Property: 352366632 (stream G-ENRRL5BHNE)
// Reuses GA4_SERVICE_ACCOUNT_JSON — same service account is Viewer on this property
//
// Query params:
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   (defaults to yesterday–yesterday)
//   ?campaign_ids=101,102,103         (optional filter — if omitted returns all)

import { BetaAnalyticsDataClient } from '@google-analytics/data';

const WEBAPP_PROPERTY_ID = '352366632';

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

  // Optional campaign ID filter (comma-separated)
  const filterIds = req.query.campaign_ids
    ? new Set(req.query.campaign_ids.split(',').map(s => s.trim()))
    : null;

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

  // ── Query ──
  // Safe pattern: eventName as dimension (NOT filter) — filter in app code
  // sessionCampaignName matches utm_campaign = Meta campaign_id
  let rawRows;
  try {
    const [response] = await client.runReport({
      property:   `properties/${WEBAPP_PROPERTY_ID}`,
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: 'sessionCampaignName' },
        { name: 'eventName' },
      ],
      metrics: [
        { name: 'eventCount' },
        { name: 'activeUsers' },
      ],
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

  // ── Parse ──
  const byCampaign = {};

  for (const row of rawRows) {
    const campaign = row.dimensionValues[0].value;
    const event    = row.dimensionValues[1].value;
    const count    = parseInt(row.metricValues[0].value, 10) || 0;
    const users    = parseInt(row.metricValues[1].value, 10) || 0;

    // Skip non-campaign traffic
    if (!campaign || campaign === '(not set)' || campaign === '(direct)' ||
        campaign === '(referral)' || campaign === '(organic)' ||
        campaign === '(cross-network)' || campaign === '') continue;

    // Apply campaign_ids filter if provided
    if (filterIds && !filterIds.has(campaign)) continue;

    if (!byCampaign[campaign]) {
      byCampaign[campaign] = { landings: 0, pod_plays: 0, wa_intent: 0, app_opens: 0 };
    }

    if (event === 'page_view')           byCampaign[campaign].landings  += users;
    else if (event === 'pod_play')       byCampaign[campaign].pod_plays += count;
    else if (WA_EVENTS.has(event))       byCampaign[campaign].wa_intent += count;
    else if (event === 'open_app_click') byCampaign[campaign].app_opens += count;
  }

  return res.status(200).json({
    from,
    to,
    property: WEBAPP_PROPERTY_ID,
    // Key: sessionCampaignName (= Meta campaign_id numeric string)
    // Value: { landings, pod_plays, wa_intent, app_opens }
    funnel: byCampaign,
  });
}
