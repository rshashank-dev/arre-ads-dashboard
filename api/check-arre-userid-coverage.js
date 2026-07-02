// TEMPORARY — api/check-arre-userid-coverage.js
// Check what % of open_app_click events actually have arre_user_id set
import { BetaAnalyticsDataClient } from '@google-analytics/data';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const from = req.query.from || '2026-06-25';
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

  // Query open_app_click on WEB, broken down by arre_user_id value (including not-set)
  const [r] = await client.runReport({
    property: 'properties/352366632',
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
    limit: 500,
  });

  const rows = (r.rows || []).map(row => ({
    pagePath: row.dimensionValues[0].value,
    arre_user_id: row.dimensionValues[1].value,
    users: parseInt(row.metricValues[0].value, 10),
  }));

  const poetsRows = rows.filter(row => row.pagePath.toLowerCase().includes('poet'));

  const withId = poetsRows.filter(row => row.arre_user_id && row.arre_user_id !== '(not set)');
  const withoutId = poetsRows.filter(row => !row.arre_user_id || row.arre_user_id === '(not set)');

  const totalUsersWithId = withId.reduce((sum, row) => sum + row.users, 0);
  const totalUsersWithoutId = withoutId.reduce((sum, row) => sum + row.users, 0);

  return res.status(200).json({
    from, to,
    total_rows_poets: poetsRows.length,
    rows_with_arre_user_id: withId.length,
    rows_without_arre_user_id: withoutId.length,
    total_users_with_id: totalUsersWithId,
    total_users_without_id: totalUsersWithoutId,
    without_id_sample: withoutId.slice(0, 5),
    with_id_sample: withId.slice(0, 5),
  });
}
