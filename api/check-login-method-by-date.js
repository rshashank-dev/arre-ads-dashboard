// TEMPORARY — api/check-login-method-by-date.js
// Check login_method dimension coverage on 'login' event, broken down by date
// This shows the trend: is coverage improving day by day since registration (2 Jul)?
import { BetaAnalyticsDataClient } from '@google-analytics/data';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const from = req.query.from || '2026-06-30';
  const to   = req.query.to   || '2026-07-03';

  const credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  const client = new BetaAnalyticsDataClient({
    credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
  });

  const [r] = await client.runReport({
    property: 'properties/352366632',
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [
      { name: 'date' },
      { name: 'customUser:login_method' },
      { name: 'platform' },
    ],
    metrics: [{ name: 'activeUsers' }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'login' } } },
          { notExpression: { filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: 'WEB' } } } },
        ],
      },
    },
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 200,
  });

  const rows = (r.rows || []).map(row => ({
    date: row.dimensionValues[0].value,
    login_method: row.dimensionValues[1].value || '(blank)',
    platform: row.dimensionValues[2].value,
    users: parseInt(row.metricValues[0].value, 10),
  }));

  // Group by date to show total vs with-value split
  const byDate = {};
  for (const row of rows) {
    if (!byDate[row.date]) byDate[row.date] = { total: 0, with_value: 0, blank: 0, values: {} };
    byDate[row.date].total += row.users;
    if (row.login_method === '(blank)' || row.login_method === '(not set)' || row.login_method === '') {
      byDate[row.date].blank += row.users;
    } else {
      byDate[row.date].with_value += row.users;
      byDate[row.date].values[row.login_method] = (byDate[row.date].values[row.login_method] || 0) + row.users;
    }
  }

  return res.status(200).json({ from, to, by_date: byDate, raw_rows: rows });
}
