// api/debug-ga4.js
// Temporary debug route — shows raw GA4 response for a date
// Remove after debugging

import { BetaAnalyticsDataClient } from '@google-analytics/data';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const date = req.query.date || '2026-06-03';
  const credentials = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
  const propertyId  = process.env.GA4_PROPERTY_ID;
  const client      = new BetaAnalyticsDataClient({ credentials });

  try {
    // Try both sessionCampaignId and sessionCampaignName to see what comes back
    const [byId] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: date, endDate: date }],
      dimensions: [
        { name: 'sessionCampaignId' },
        { name: 'sessionCampaignName' },
        { name: 'hostName' },
      ],
      metrics: [{ name: 'activeUsers' }],
    });

    const rows = (byId.rows || []).map(r => ({
      campaignId:   r.dimensionValues[0].value,
      campaignName: r.dimensionValues[1].value,
      hostName:     r.dimensionValues[2].value,
      users:        r.metricValues[0].value,
    }));

    return res.status(200).json({ date, rows, total: rows.length });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
