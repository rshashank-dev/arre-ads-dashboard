// /api/retention.js
// Ad-attributed user retention — D1/D7/D15/D30 — computed from BigQuery AllUsersV2.
//
// Uses BQ_SERVICE_ACCOUNT_JSON env var (BigQuery Data Viewer + Job User roles).
//
// ── Definitions ──
// "Day 0" has 4 selectable milestones (BigQuery signals only):
//   1. open_app_click : earliest web-* record carrying a UTMCAMPAIGN-* tag
//   2. reached_login   : earliest native (non-web) appVersion record
//   3. signup_complete : earliest record where verificationStatus = 'normal'
//   4. onboarding_complete : earliest record where verificationStatus='normal'
//                             AND isSignUpComplete = true
//
// "Retention" on D-N = does the user have ANY AllUsersV2 record whose
// lastModifiedDateTimeIndia falls EXACTLY N days after their Day 0 date.
//
// IMPORTANT — eligibility window (fixed 5 Jul 2026):
// A user is only "eligible" to be counted in a D-N bucket if day0 + N days has
// actually already happened (day0 <= today - N days). Without this, users who
// joined too recently to have reached D7/D15/D30 yet were being counted as
// "0% retained" in the denominator — which is wrong: their window simply hasn't
// elapsed, they haven't failed to return. Each bucket now has its own eligible
// cohort size, and returns is_measurable=false with pct=null when eligible=0.
//
// Campaign filter: matches UTMCAMPAIGN-<campaign_id> tag in internalTags.
// campaign_id=all means "any UTMCAMPAIGN-* tag present".

import { BigQuery } from '@google-cloud/bigquery';

const PROJECT_ID = 'arre-voice-490616';
const DATASET    = 'arre_analytics';
const TABLE      = 'AllUsersV2';
const BUCKETS    = [1, 7, 15, 30];

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

  // Require a web-* session record too — aligns this cohort with app-funnel.js,
  // which starts from GA4's open_app_click event on the webapp. Without this,
  // retention could include users tagged via a path that never touched the
  // webapp at all, making the two pages' numbers incomparable. Validated 5 Jul
  // 2026: narrows a 19-user cohort to 17 — the remaining small gap vs
  // app-funnel's count is the known arre_user_id GA4-stitching coverage issue.
  const webSessionFilter = `AND EXISTS (
    SELECT 1 FROM \`${PROJECT_ID}.${DATASET}.${TABLE}\` w
    WHERE w.userId = u.userId AND STARTS_WITH(COALESCE(w.appVersion,''), 'web')
  )`;

  // For each bucket N, eligible = day0 is far enough in the past that day0+N <= today.
  // retained = eligible AND has an activity record on exactly day0+N.
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
      WHERE ${m.day0Where}
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
    const results = {};
    const milestoneKeys = Object.keys(MILESTONES);

    await Promise.all(milestoneKeys.map(async (key) => {
      const sql = buildQuery(key, campaignId);
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

      results[key] = {
        label: MILESTONES[key].label,
        cohort_size: cohortSize,
        ...buckets,
      };
    }));

    return res.status(200).json({ from, to, campaign_id: campaignId, milestones: results });
  } catch (e) {
    return res.status(500).json({ error: 'BigQuery query failed', detail: e.message });
  }
}
