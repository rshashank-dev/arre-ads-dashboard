// TEMPORARY — api/check-session-count.js
// Test if customEvent:session_count now works as a dimension after registration
// Also test customUser:arre_user_id with app_session_start

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

  // Test 1: app_session_start broken down by session_count (now registered as custom metric)
  // Try as customEvent:session_count dimension
  try {
    const [r] = await client.runReport({
      property: 'properties/352366632',
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: 'eventName' },
        { name: 'platform' },
        { name: 'customEvent:session_count' },
      ],
      metrics: [{ name: 'activeUsers' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'app_session_start' } } },
            { notExpression: { filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: 'WEB' } } } },
          ]
        }
      },
      limit: 20,
    });
    results.app_session_start_by_session_count_dim = (r.rows || []).map(row => ({
      event: row.dimensionValues[0].value,
      platform: row.dimensionValues[1].value,
      session_count: row.dimensionValues[2].value,
      users: parseInt(row.metricValues[0].value),
    }));
  } catch (e) {
    results.app_session_start_by_session_count_dim = { error: e.message };
  }

  // Test 2: app_session_start with arre_user_id — does it stitch?
  // If arre_user_id is set 2 seconds later, GA4 should retroactively apply it
  try {
    const [r] = await client.runReport({
      property: 'properties/352366632',
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: 'eventName' },
        { name: 'platform' },
        { name: 'customUser:arre_user_id' },
      ],
      metrics: [{ name: 'activeUsers' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'app_session_start' } } },
            { notExpression: { filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: 'WEB' } } } },
            // exclude (not set)
            { notExpression: { filter: { fieldName: 'customUser:arre_user_id', stringFilter: { matchType: 'EXACT', value: '(not set)' } } } },
          ]
        }
      },
      limit: 50,
    });
    const rows = (r.rows || []).map(row => ({
      event: row.dimensionValues[0].value,
      platform: row.dimensionValues[1].value,
      arre_user_id: row.dimensionValues[2].value,
      users: parseInt(row.metricValues[0].value),
    }));
    results.app_session_start_with_arre_user_id = {
      total_stitched_users: rows.length,
      sample: rows.slice(0, 5),
    };
  } catch (e) {
    results.app_session_start_with_arre_user_id = { error: e.message };
  }

  // Test 3: session_count as custom metric — can we get it alongside events?
  try {
    const [r] = await client.runReport({
      property: 'properties/352366632',
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: 'eventName' }, { name: 'platform' }],
      metrics: [{ name: 'activeUsers' }, { name: 'customEvent:session_count' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'app_session_start' } } },
            { notExpression: { filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: 'WEB' } } } },
          ]
        }
      },
      limit: 5,
    });
    results.app_session_start_session_count_metric = (r.rows || []).map(row => ({
      event: row.dimensionValues[0].value,
      platform: row.dimensionValues[1].value,
      users: parseInt(row.metricValues[0].value),
      total_session_count: parseInt(row.metricValues[1].value),
    }));
  } catch (e) {
    results.app_session_start_session_count_metric = { error: e.message };
  }

  return res.status(200).json({ from, to, ...results });
}
