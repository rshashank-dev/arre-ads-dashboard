// TEMPORARY — api/check-userid-dimension.js
// Compare GA4's built-in "userId" dimension vs our custom "customUser:arre_user_id"
// to see which has better coverage on open_app_click events
import { BetaAnalyticsDataClient } from '@google-analytics/data';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const from = req.query.from || '2026-07-02';
  const to   = req.query.to   || '2026-07-02';

  let credentials;
  try {
    credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    return res.status(500).json({ error: 'GA4_SERVICE_ACCOUNT_JSON missing' });
  }

  const client = new BetaAnalyticsDataClient({
    credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
  });

  const results = {};

  // Test 1: Built-in "userId" dimension on open_app_click (poets page)
  try {
    const [r] = await client.runReport({
      property: 'properties/352366632',
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: 'pagePath' }, { name: 'userId' }],
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
      userId: row.dimensionValues[1].value,
      users: parseInt(row.metricValues[0].value, 10),
    }));
    const poetsRows = rows.filter(row => row.pagePath.toLowerCase().includes('poet'));
    const withId = poetsRows.filter(row => row.userId && row.userId !== '(not set)');
    const withoutId = poetsRows.filter(row => !row.userId || row.userId === '(not set)');
    results.builtin_userId_dimension = {
      total_rows: poetsRows.length,
      rows_with_id: withId.length,
      rows_without_id: withoutId.length,
      users_with_id: withId.reduce((s,r)=>s+r.users,0),
      users_without_id: withoutId.reduce((s,r)=>s+r.users,0),
    };
  } catch (e) {
    results.builtin_userId_dimension = { error: e.message };
  }

  // Test 2: customUser:arre_user_id (what we're currently using) — for comparison
  try {
    const [r] = await client.runReport({
      property: 'properties/352366632',
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: 'pagePath' }, { name: 'customUser:arre_user_id' }],
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
    const withId = poetsRows.filter(row => row.arre_user_id && row.arre_user_id !== '(not set)' && row.arre_user_id !== '');
    const withoutId = poetsRows.filter(row => !row.arre_user_id || row.arre_user_id === '(not set)' || row.arre_user_id === '');
    results.custom_arre_user_id_dimension = {
      total_rows: poetsRows.length,
      rows_with_id: withId.length,
      rows_without_id: withoutId.length,
      users_with_id: withId.reduce((s,r)=>s+r.users,0),
      users_without_id: withoutId.reduce((s,r)=>s+r.users,0),
    };
  } catch (e) {
    results.custom_arre_user_id_dimension = { error: e.message };
  }

  return res.status(200).json({ from, to, ...results });
}
