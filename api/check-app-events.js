// TEMPORARY — api/check-app-events.js
// Check what events exist on ANDROID/IOS platform in GA4 property 352366632
// Also check if app_session_start exists and what dimensions are available

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

  // Query 1: All events on ANDROID/IOS — what exists?
  const [allApp] = await client.runReport({
    property: 'properties/352366632',
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: 'eventName' }, { name: 'platform' }],
    metrics: [{ name: 'activeUsers' }, { name: 'eventCount' }],
    dimensionFilter: {
      notExpression: {
        filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: 'WEB' } }
      }
    },
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 50,
  });

  // Query 2: Specifically check app_session_start with session_count dimension
  let sessionRows = [];
  try {
    const [sess] = await client.runReport({
      property: 'properties/352366632',
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [
        { name: 'eventName' },
        { name: 'platform' },
        { name: 'customEvent:session_count' },  // event-scoped param
      ],
      metrics: [{ name: 'activeUsers' }, { name: 'eventCount' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          stringFilter: { matchType: 'EXACT', value: 'app_session_start' }
        }
      },
      limit: 20,
    });
    sessionRows = (sess.rows || []).map(r => ({
      event: r.dimensionValues[0].value,
      platform: r.dimensionValues[1].value,
      session_count: r.dimensionValues[2].value,
      users: parseInt(r.metricValues[0].value),
      count: parseInt(r.metricValues[1].value),
    }));
  } catch (e) {
    sessionRows = [{ error: e.message }];
  }

  // Query 3: session_start (Firebase default) on app platforms
  let sessionStartRows = [];
  try {
    const [ss] = await client.runReport({
      property: 'properties/352366632',
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: 'eventName' }, { name: 'platform' }, { name: 'sessionNumber' }],
      metrics: [{ name: 'activeUsers' }, { name: 'eventCount' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'session_start' } } },
            { notExpression: { filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: 'WEB' } } } },
          ]
        }
      },
      orderBys: [{ dimension: { dimensionName: 'sessionNumber' }, desc: false }],
      limit: 10,
    });
    sessionStartRows = (ss.rows || []).map(r => ({
      event: r.dimensionValues[0].value,
      platform: r.dimensionValues[1].value,
      session_number: r.dimensionValues[2].value,
      users: parseInt(r.metricValues[0].value),
      count: parseInt(r.metricValues[1].value),
    }));
  } catch (e) {
    sessionStartRows = [{ error: e.message }];
  }

  const appEvents = (allApp.rows || []).map(r => ({
    event: r.dimensionValues[0].value,
    platform: r.dimensionValues[1].value,
    users: parseInt(r.metricValues[0].value),
    count: parseInt(r.metricValues[1].value),
  }));

  return res.status(200).json({
    from, to,
    note: 'Delete after use',
    all_app_events: appEvents,
    app_session_start_by_session_count: sessionRows,
    session_start_by_session_number: sessionStartRows,
  });
}
