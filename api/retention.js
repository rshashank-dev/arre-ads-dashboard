// /api/retention.js
// Ad-attributed user retention — D1/D7/D15/D30 — computed from BigQuery AllUsersV2.
//
// Uses BQ_SERVICE_ACCOUNT_JSON env var (same credential added for app-funnel.js
// hybrid pipeline, 5 Jul 2026 — BigQuery Data Viewer + Job User roles).
//
// ── Definitions ──
// "Day 0" has 4 selectable milestones (we only have BigQuery signals, not GA4
// event timestamps, to define these):
//   1. open_app_click : earliest web-* record carrying a UTMCAMPAIGN-* tag
//   2. reached_login   : earliest native (non-web) appVersion record
//   3. signup_complete : earliest record where verificationStatus = 'normal'
//   4. onboarding_complete : earliest record where verificationStatus='normal'
//                             AND isSignUpComplete = true
//
// "Retention" on D1/D7/D15/D30 = does the user have ANY AllUsersV2 record whose
// lastModifiedDateTimeIndia falls EXACTLY N days after their Day 0 date
// (DATE_DIFF-based, single-day retention curve — not cumulative/rolling).
//
// Campaign filter: matches UTMCAMPAIGN-<campaign_id> tag in internalTags.
// campaign_id=all means "any UTMCAMPAIGN-* tag present".

import { BigQuery } from '@google-cloud/bigquery';

const PROJECT_ID = 'arre-voice-490616';
const DATASET    = 'arre_analytics';
const TABLE      = 'AllUsersV2';

const MILESTONES = {
  open_app_click: {
    label: 'Clicked Open App',
    day0Where: `STARTS_WITH(COALESCE(u.appVersion,''), 'web')`,
  },
  reached_login: {
    label: 'Reached Login / Opened App',
    day0Where: `NOT STARTS_WITH(COALESCE(u.appVersion,''), 'web') AND u.appVersion IS NOT NULL`,
  },
  signup_complete: {
    label: 'Completed Signup',
    day0Where: `u.verificationStatus = 'normal'`,
  },
  onboarding_complete: {
    label: 'Finished Onboarding',
    day0Where: `u.verificationStatus = 'normal' AND u.isSignUpComplete = true`,
  },
};

function buildQuery(milestoneKey, campaignId) {
  const m = MILESTONES[milestoneKey];

  const campaignFilter = campaignId && campaignId !== 'all'
    ? `AND EXISTS (SELECT 1 FROM UNNEST(u.internalTags) t WHERE t = CONCAT('UTMCAMPAIGN-', @campaignId))`
    : `AND EXISTS (SELECT 1 FROM UNNEST(u.internalTags) t WHERE STARTS_WITH(t, 'UTMCAMPAIGN-'))`;

  return `
    WITH cohort AS (
      SELECT DISTINCT u.userId
      FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\` u
      WHERE 1=1 ${campaignFilter}
    ),
    milestone_date AS (
      SELECT u.userId, DATE(MIN(u.lastModifiedDateTimeIndia)) AS day0
      FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\` u
      JOIN cohort c ON u.userId = c.userId
      WHERE ${m.day0Where}
      GROUP BY u.userId
      HAVING day0 BETWEEN @fromDate AND @toDate
    ),
    activity AS (
      SELECT u.userId, m.day0, DATE(u.lastModifiedDateTimeIndia) AS activity_date
      FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\` u
      JOIN milestone_date m ON u.userId = m.userId
    )
    SELECT
      (SELECT COUNT(DISTINCT userId) FROM milestone_date) AS cohort_size,
      COUNT(DISTINCT CASE WHEN DATE_DIFF(activity_date, day0, DAY) = 1  THEN userId END) AS d1,
      COUNT(DISTINCT CASE WHEN DATE_DIFF(activity_date, day0, DAY) = 7  THEN userId END) AS d7,
      COUNT(DISTINCT CASE WHEN DATE_DIFF(activity_date, day0, DAY) = 15 THEN userId END) AS d15,
      COUNT(DISTINCT CASE WHEN DATE_DIFF(activity_date, day0, DAY) = 30 THEN userId END) AS d30
    FROM activity
  `;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const from       = req.query.from;
  const to         = req.query.to;
  const campaignId = req.query.campaign_id || 'all';

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to date params are required (Day 0 date range)' });
  }

  let credentials;
  try {
    credentials = JSON.parse(process.env.BQ_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    return res.status(500).json({ error: 'BQ_SERVICE_ACCOUNT_JSON missing or invalid' });
  }

  const bigquery = new BigQuery({
    projectId: PROJECT_ID,
    credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
  });

  try {
    const results = {};
    const milestoneKeys = Object.keys(MILESTONES);

    await Promise.all(milestoneKeys.map(async (key) => {
      const sql = buildQuery(key, campaignId);
      const params = { fromDate: from, toDate: to };
      if (campaignId !== 'all') params.campaignId = campaignId;

      const [rows] = await bigquery.query({ query: sql, params });
      const row = rows[0] || { cohort_size: 0, d1: 0, d7: 0, d15: 0, d30: 0 };
      const cohortSize = parseInt(row.cohort_size, 10) || 0;

      function pct(n) { return cohortSize > 0 ? +((n / cohortSize) * 100).toFixed(1) : 0; }

      results[key] = {
        label: MILESTONES[key].label,
        cohort_size: cohortSize,
        d1:  { count: parseInt(row.d1,10)  || 0, pct: pct(parseInt(row.d1,10)  || 0) },
        d7:  { count: parseInt(row.d7,10)  || 0, pct: pct(parseInt(row.d7,10)  || 0) },
        d15: { count: parseInt(row.d15,10) || 0, pct: pct(parseInt(row.d15,10) || 0) },
        d30: { count: parseInt(row.d30,10) || 0, pct: pct(parseInt(row.d30,10) || 0) },
      };
    }));

    return res.status(200).json({ from, to, campaign_id: campaignId, milestones: results });
  } catch (e) {
    return res.status(500).json({ error: 'BigQuery query failed', detail: e.message });
  }
}
