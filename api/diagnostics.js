// /api/diagnostics.js
// PERMANENT reusable GA4 diagnostic tool — deploy once, query with different params anytime.
// Two modes: "raw" (arbitrary GA4 query) and "coverage" (check how often a dimension has
// a real value vs blank/not-set — used for arre_user_id, login_method, etc.)
//
// ── MODE: raw ──
// Returns raw rows for any dimension/metric combo with optional filters.
// Params:
//   mode=raw
//   dimensions=pagePath,customUser:arre_user_id      (comma-separated GA4 API dimension names)
//   metrics=activeUsers                              (comma-separated, default activeUsers)
//   eventName=open_app_click                         (exact match filter, optional)
//   eventNames=signup_initiate,onboarding_done_click (comma list, inList filter, optional)
//   platform=WEB | ANDROID | IOS | APP | ALL          (APP = NOT WEB; default ALL)
//   pagePathContains=poet                             (optional, case-insensitive contains)
//   userIds=id1,id2,id3                               (optional, inList filter on customUser:arre_user_id)
//   groupByDate=true                                  (prepends 'date' dimension)
//   from=2026-07-04&to=2026-07-04
//   limit=500
//
// ── MODE: coverage ──
// Checks what % of events have a real value on a given dimension vs blank/(not set).
// Params:
//   mode=coverage
//   idDimension=customUser:arre_user_id | customUser:login_method   (required)
//   eventName=open_app_click | login                                 (required)
//   platform=WEB | APP | ALL                                         (default ALL)
//   pagePathContains=poet                                            (optional — bucket by page)
//   keywords=poet,singer                                             (optional — bucket by multiple keywords at once)
//   groupByDate=true                                                 (optional — trend over days)
//   from=2026-07-04&to=2026-07-04

import { BetaAnalyticsDataClient } from '@google-analytics/data';

const PROPERTY_ID = '352366632';

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function buildPlatformFilter(platform) {
  if (!platform || platform === 'ALL') return null;
  if (platform === 'APP') {
    return { notExpression: { filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: 'WEB' } } } };
  }
  return { filter: { fieldName: 'platform', stringFilter: { matchType: 'EXACT', value: platform } } };
}

async function runQuery(client, { dimensions, metrics, dateRanges, dimensionFilter, limit }) {
  const [r] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges,
    dimensions: dimensions.map(name => ({ name })),
    metrics: metrics.map(name => ({ name })),
    dimensionFilter,
    limit: limit || 500,
  });
  return r.rows || [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const q = req.query;
  const from = q.from || yesterday();
  const to   = q.to   || from;
  const mode = q.mode || 'raw';

  let credentials;
  try {
    credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    return res.status(500).json({ error: 'GA4_SERVICE_ACCOUNT_JSON missing or invalid' });
  }
  const client = new BetaAnalyticsDataClient({
    credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
  });

  const dateRanges = [{ startDate: from, endDate: to }];

  try {
    if (mode === 'raw') {
      let dims = (q.dimensions || 'eventName').split(',').map(s => s.trim()).filter(Boolean);
      if (q.groupByDate === 'true') dims = ['date', ...dims];
      const metrics = (q.metrics || 'activeUsers').split(',').map(s => s.trim()).filter(Boolean);

      const expressions = [];
      if (q.eventName) {
        expressions.push({ filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: q.eventName } } });
      }
      if (q.eventNames) {
        expressions.push({ filter: { fieldName: 'eventName', inListFilter: { values: q.eventNames.split(',').map(s=>s.trim()) } } });
      }
      const platformFilter = buildPlatformFilter(q.platform);
      if (platformFilter) expressions.push(platformFilter);
      if (q.pagePathContains) {
        expressions.push({ filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: q.pagePathContains, caseSensitive: false } } });
      }
      if (q.userIds) {
        expressions.push({ filter: { fieldName: 'customUser:arre_user_id', inListFilter: { values: q.userIds.split(',').map(s=>s.trim()) } } });
      }

      const dimensionFilter = expressions.length ? { andGroup: { expressions } } : undefined;
      const rows = await runQuery(client, { dimensions: dims, metrics, dateRanges, dimensionFilter, limit: parseInt(q.limit) || 500 });

      const parsed = rows.map(row => {
        const obj = {};
        dims.forEach((d, i) => obj[d] = row.dimensionValues[i].value);
        metrics.forEach((m, i) => obj[m] = row.metricValues[i].value);
        return obj;
      });

      return res.status(200).json({ mode, from, to, dimensions: dims, metrics, row_count: parsed.length, rows: parsed });
    }

    if (mode === 'coverage') {
      if (!q.idDimension || !q.eventName) {
        return res.status(400).json({ error: 'coverage mode requires idDimension and eventName params' });
      }
      let dims = ['pagePath', q.idDimension];
      if (q.groupByDate === 'true') dims = ['date', ...dims];

      const expressions = [
        { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: q.eventName } } },
      ];
      const platformFilter = buildPlatformFilter(q.platform || 'ALL');
      if (platformFilter) expressions.push(platformFilter);

      const dimensionFilter = { andGroup: { expressions } };
      const rows = await runQuery(client, { dimensions: dims, metrics: ['activeUsers'], dateRanges, dimensionFilter, limit: 2000 });

      const idIdx = dims.indexOf(q.idDimension);
      const pageIdx = dims.indexOf('pagePath');
      const dateIdx = dims.indexOf('date');

      const parsed = rows.map(row => ({
        date: dateIdx >= 0 ? row.dimensionValues[dateIdx].value : null,
        pagePath: row.dimensionValues[pageIdx].value,
        idValue: row.dimensionValues[idIdx].value,
        users: parseInt(row.metricValues[0].value, 10),
      }));

      function isBlank(v) { return !v || v === '(not set)' || v === ''; }

      function summarize(filterFn, groupKey) {
        const filtered = parsed.filter(filterFn);
        const groups = {};
        for (const row of filtered) {
          const key = groupKey(row);
          if (!groups[key]) groups[key] = { total: 0, with_value: 0, blank: 0, values: {} };
          groups[key].total += row.users;
          if (isBlank(row.idValue)) {
            groups[key].blank += row.users;
          } else {
            groups[key].with_value += row.users;
            groups[key].values[row.idValue] = (groups[key].values[row.idValue] || 0) + row.users;
          }
        }
        for (const k of Object.keys(groups)) {
          const g = groups[k];
          g.coverage_pct = g.total ? ((g.with_value / g.total) * 100).toFixed(1) : '0.0';
        }
        return groups;
      }

      const result = { mode, from, to, idDimension: q.idDimension, eventName: q.eventName };

      if (q.keywords) {
        const keywords = q.keywords.split(',').map(s => s.trim().toLowerCase());
        result.by_keyword = {};
        for (const kw of keywords) {
          result.by_keyword[kw] = summarize(
            row => row.pagePath.toLowerCase().includes(kw),
            row => q.groupByDate === 'true' ? row.date : 'all'
          );
        }
      } else if (q.pagePathContains) {
        const kw = q.pagePathContains.toLowerCase();
        result.filtered = summarize(
          row => row.pagePath.toLowerCase().includes(kw),
          row => q.groupByDate === 'true' ? row.date : 'all'
        );
      } else {
        result.overall = summarize(
          () => true,
          row => q.groupByDate === 'true' ? row.date : 'all'
        );
      }

      return res.status(200).json(result);
    }

    return res.status(400).json({ error: `Unknown mode: ${mode}. Use mode=raw or mode=coverage` });
  } catch (e) {
    return res.status(500).json({ error: 'GA4 query failed', detail: e.message, mode, from, to });
  }
}
