// /api/retention.js
// Ad-attributed user retention — D1/D7/D15/D30 — computed from BigQuery AllUsersV2.
//
// Uses BQ_SERVICE_ACCOUNT_JSON env var (BigQuery Data Viewer + Job User roles).
//
// ── Definition ──
// "Day 0" = earliest record where verificationStatus='normal' AND
// isSignUpComplete=true (i.e. user completed onboarding, reached home screen).
//
// "Retention" on D-N = does the user have ANY AllUsersV2 record whose
// lastModifiedDateTimeIndia falls EXACTLY N days after their Day 0 date.
//
// Cohort = users with the campaign's UTMCAMPAIGN-<id> tag in internalTags AND
// at least one web-* session record (came via webapp) — aligns this cohort
// with app-funnel.js, which starts from GA4's open_app_click on the webapp.
// campaign_id=all means "any UTMCAMPAIGN-* tag present".
//
// Eligibility window: a user only counts in a D-N bucket if day0+N days has
// already happened (day0 <= today - N days) — otherwise that bucket returns
// measurable=false, pct=null, since the window hasn't elapsed yet.

import { BigQuery } from '@google-cloud/bigquery';

const PROJECT_ID = 'arre-voice-490616';
const DATASET    = 'arre_analytics';
const TABLE      = 'AllUsersV2';
const BUCKETS    = [1, 7, 15, 30];
const MILESTONE_LABEL = 'Finished Onboarding';
const DAY0_WHERE = `u.verificationStatus = 'normal' AND u.isSignUpComplete = true`;

function buildQuery(campaignId) {
  const campaignFilter = campaignId && campaignId !== 'all'
    ? `AND EXISTS (SELECT 1 FROM UNNEST(u.internalTags) t WHERE t = CONCAT('UTMCAMPAIGN-', @campaignId))`
    : `AND EXISTS (SELECT 1 FROM UNNEST(u.internalTags) t WHERE STARTS_WITH(t, 'UTMCAMPAIGN-'))`;

  const webSessionFilter = `AND EXISTS (
    SELECT 1 FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\` w
    WHERE w.userId = u.userId AND STARTS_WITH(COALESCE(w.appVersion,''), 'web')
  )`;

  const bucketSelects = BUCKETS.map(n => `
    COUNTIF(md.day0 <= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL ${n} DAY)) AS eligible_d${n},
    COUNT(DISTINCT CASE
      WHEN md.day0 <= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL ${n} DAY)
       AND EXISTS (
         SELECT 1 FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\` a
         WHERE a.userId = md.userId
           AND DATE(a.lastModifiedDateTimeIndia) = DATE_ADD(md.day0, INTERVAL ${n} DAY)
       )
      THEN md.userId END) AS retained_d${n}
  `).join(',\n');

  return `
    WITH cohort AS (
      SELECT DISTINCT u.userId
      FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\` u
      WHERE 1=1 ${campaignFilter} ${webSessionFilter}
    ),
    md AS (
      SELECT u.userId, DATE(MIN(u.lastModifiedDateTimeIndia)) AS day0
      FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\` u
      JOIN cohort c ON u.userId = c.userId
      WHERE ${DAY0_WHERE}
      GROUP BY u.userId
      HAVING day0 BETWEEN @fromDate AND @toDate
    )
    SELECT
      COUNT(DISTINCT md.userId) AS cohort_size,
      ${bucketSelects}
    FROM md
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
    const sql = buildQuery(campaignId);
    const params = { fromDate: from, toDate: to };
    if (campaignId !== 'all') params.campaignId = campaignId;

    const [rows] = await bigquery.query({ query: sql, params });
    const row = rows[0] || {};
    const cohortSize = parseInt(row.cohort_size, 10) || 0;

    const buckets = {};
    for (const n of BUCKETS) {
      const eligible = parseInt(row[`eligible_d${n}`], 10) || 0;
      const retained = parseInt(row[`retained_d${n}`], 10) || 0;
      buckets[`d${n}`] = eligible > 0
        ? { count: retained, eligible, pct: +((retained / eligible) * 100).toFixed(1), measurable: true }
        : { count: 0, eligible: 0, pct: null, measurable: false };
    }

    return res.status(200).json({
      from, to, campaign_id: campaignId,
      milestone: { label: MILESTONE_LABEL, cohort_size: cohortSize, ...buckets },
    });
  } catch (e) {
    return res.status(500).json({ error: 'BigQuery query failed', detail: e.message });
  }
}
