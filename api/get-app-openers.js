// TEMPORARY — api/get-app-openers.js
// Gets all arre_user_id values who fired open_app_click on the poet/singer pages
import { BetaAnalyticsDataClient } from '@google-analytics/data';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const from = req.query.from || '2026-07-01';
  const to   = req.query.to   || '2026-07-01';

  let credentials;
  try {
    credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    return res.status(500).json({ error: 'GA4_SERVICE_ACCOUNT_JSON missing' });
  }

  const client = new BetaAnalyticsDataClient({
    credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
  });

  // Query: pagePath + eventName + arre_user_id dimension
  // Filter: open_app_click only, platform=WEB
  const [response] = await client.runReport({
    property: 'properties/352366632',
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [
      { name: 'pagePath' },
      { name: 'eventName' },
      { name: 'customUser:arre_user_id' },  // the user property set at guest login
    ],
    metrics: [{ name: 'activeUsers' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          { filter: { fieldName: 'eventName',  stringFilter: { matchType: 'EXACT',    value: 'open_app_click' } } },
          { filter: { fieldName: 'platform',   stringFilter: { matchType: 'EXACT',    value: 'WEB' } } },
        ]
      }
    },
    limit: 500,
  });

  const PAGE_KEYWORD_MAP = { 'poet': '6966808714983', 'singer': '6987389224583' };

  const rows = (response.rows || []).map(r => {
    const pagePath  = r.dimensionValues[0].value;
    const event     = r.dimensionValues[1].value;
    const userId    = r.dimensionValues[2].value;
    const users     = parseInt(r.metricValues[0].value, 10);

    let campaignId = null;
    for (const [kw, cid] of Object.entries(PAGE_KEYWORD_MAP)) {
      if (pagePath.toLowerCase().includes(kw)) { campaignId = cid; break; }
    }

    return { pagePath, event, userId, users, campaignId };
  });

  // Filter out (not set) userIds
  const withId    = rows.filter(r => r.userId && r.userId !== '(not set)');
  const withoutId = rows.filter(r => !r.userId || r.userId === '(not set)');

  return res.status(200).json({
    from, to,
    total_rows: rows.length,
    with_arre_user_id: withId.length,
    without_arre_user_id: withoutId.length,
    user_ids: withId.map(r => r.userId),
    rows: withId,
  });
}
