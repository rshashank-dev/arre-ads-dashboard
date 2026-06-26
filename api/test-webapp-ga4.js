// /api/test-webapp-ga4.js
// Standalone test — fetches yesterday's funnel events from the new GA4 WebApp property
// Property: a74641997p352366632 (stream G-ENRRL5BHNE)
// Reuses existing GA4_SERVICE_ACCOUNT_JSON credential — same service account is Viewer on this property

import { BetaAnalyticsDataClient } from '@google-analytics/data';

const WEBAPP_PROPERTY_ID = 'a74641997p352366632';

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const date = req.query.date || yesterday();

  // Auth
  let credentials;
  try {
    credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    return res.status(500).json({ error: 'GA4_SERVICE_ACCOUNT_JSON missing or invalid', detail: e.message });
  }

  const client = new BetaAnalyticsDataClient({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },
  });

  // Query: sessionCampaignName + eventName as dimensions (NOT as filter — safe pattern)
  let rawRows;
  try {
    const [response] = await client.runReport({
      property: `properties/${WEBAPP_PROPERTY_ID}`,
      dateRanges: [{ startDate: date, endDate: date }],
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
      error: 'GA4 query failed',
      detail: e.message,
      property: WEBAPP_PROPERTY_ID,
      date,
    });
  }

  // Parse: group by campaign, bucket each event
  // WA intent = any of these event names
  const WA_EVENTS = new Set(['whatsapp_click', 'whatsapp_join_click', 'campaign_join_whatsapp_click']);

  const byCampaign = {};

  for (const row of rawRows) {
    const campaign = row.dimensionValues[0].value;
    const event    = row.dimensionValues[1].value;
    const count    = parseInt(row.metricValues[0].value, 10) || 0;
    const users    = parseInt(row.metricValues[1].value, 10) || 0;

    if (!byCampaign[campaign]) {
      byCampaign[campaign] = { landings: 0, pod_plays: 0, wa_intent: 0, app_opens: 0, _raw: [] };
    }

    byCampaign[campaign]._raw.push({ event, count, users });

    if (event === 'page_view')           byCampaign[campaign].landings   += users;
    else if (event === 'pod_play')       byCampaign[campaign].pod_plays  += count;
    else if (WA_EVENTS.has(event))       byCampaign[campaign].wa_intent  += count;
    else if (event === 'open_app_click') byCampaign[campaign].app_opens  += count;
  }

  // Strip _raw from summary but keep in full output for debugging
  const summary = {};
  for (const [k, v] of Object.entries(byCampaign)) {
    const { _raw, ...rest } = v;
    summary[k] = rest;
  }

  return res.status(200).json({
    date,
    property: WEBAPP_PROPERTY_ID,
    total_raw_rows: rawRows.length,
    // Distinct event names seen — critical: tells us the real event names in this property
    distinct_events: [...new Set(rawRows.map(r => r.dimensionValues[1].value))].sort(),
    // Distinct campaign names seen
    distinct_campaigns: [...new Set(rawRows.map(r => r.dimensionValues[0].value))].sort(),
    // Per-campaign summary
    campaigns: summary,
    // Full raw rows for deep inspection
    raw: rawRows.map(r => ({
      campaign: r.dimensionValues[0].value,
      event:    r.dimensionValues[1].value,
      count:    r.metricValues[0].value,
      users:    r.metricValues[1].value,
    })),
  });
}
