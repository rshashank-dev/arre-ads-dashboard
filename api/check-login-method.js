// TEMPORARY — api/check-login-method.js
// Test login_method as User-scoped dimension with app_session_start
// Also test combining arre_user_id + login_method

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

  // Test 1: app_session_start broken down by login_method (User-scoped)
  try {
    const [r] = await client.runReport({
      property: 'properties/352366632',
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: 'eventName' },
        { name: 'platform' },
        { name: 'customUser:login_method' },
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
    results.app_session_start_by_login_method = (r.rows || []).map(row => ({
      event:        row.dimensionValues[0].value,
      platform:     row.dimensionValues[1].value,
      login_method: row.dimensionValues[2].value,
      users:        parseInt(row.metricValues[0].value),
    }));
  } catch (e) {
    results.app_session_start_by_login_method = { error: e.message };
  }

  // Test 2: Filter app_session_start to login_method=guest AND has arre_user_id
  try {
    const [r] = await client.runReport({
      property: 'properties/352366632',
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: 'eventName' },
        { name: 'platform' },
        { name: 'customUser:login_method' },
        { name: 'customUser:arre_user_id' },
      ],
      metrics: [{ name: 'activeUsers' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'app_session_start' } } },
            { notExpression: { filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: 'WEB' } } } },
            { filter: { fieldName: 'customUser:login_method', stringFilter: { matchType: 'EXACT', value: 'guest' } } },
            { notExpression: { filter: { fieldName: 'customUser:arre_user_id', stringFilter: { matchType: 'EXACT', value: '(not set)' } } } },
          ]
        }
      },
      limit: 100,
    });
    const rows = (r.rows || []).map(row => ({
      event:         row.dimensionValues[0].value,
      platform:      row.dimensionValues[1].value,
      login_method:  row.dimensionValues[2].value,
      arre_user_id:  row.dimensionValues[3].value,
      users:         parseInt(row.metricValues[0].value),
    }));
    results.guest_app_session_start_with_arre_user_id = {
      total: rows.length,
      sample: rows.slice(0, 5),
    };
  } catch (e) {
    results.guest_app_session_start_with_arre_user_id = { error: e.message };
  }

  // Test 3: All onboarding funnel events for login_method=guest users
  // This is what the app funnel would look like if we use login_method=guest as filter
  const FUNNEL_EVENTS = [
    'app_session_start', 'signup_initiate',
    'onboarding_display_name_next', 'onboarding_username_next',
    'onboarding_done_click', 'permission_action', 'home_feed_tab_view'
  ];
  try {
    const [r] = await client.runReport({
      property: 'properties/352366632',
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: 'eventName' },
        { name: 'platform' },
      ],
      metrics: [{ name: 'activeUsers' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', inListFilter: { values: FUNNEL_EVENTS } } },
            { notExpression: { filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: 'WEB' } } } },
            { filter: { fieldName: 'customUser:login_method', stringFilter: { matchType: 'EXACT', value: 'guest' } } },
          ]
        }
      },
      limit: 50,
    });
    results.funnel_for_guest_users = (r.rows || []).map(row => ({
      event:    row.dimensionValues[0].value,
      platform: row.dimensionValues[1].value,
      users:    parseInt(row.metricValues[0].value),
    }));
  } catch (e) {
    results.funnel_for_guest_users = { error: e.message };
  }

  return res.status(200).json({ from, to, ...results });
}
