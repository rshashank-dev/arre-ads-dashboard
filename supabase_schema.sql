-- Run this once in Supabase SQL Editor

create table if not exists ads_campaigns (
  id            bigserial primary key,
  sync_date     date not null,          -- the date this row covers (always yesterday)
  campaign_name text not null,
  src           text not null,          -- 'meta' or 'google'

  -- Meta fields
  impressions   bigint   default 0,
  reach         bigint   default 0,
  clicks        bigint   default 0,
  spent         numeric  default 0,
  cpc           numeric  default 0,
  landings      bigint   default 0,

  -- GA4 fields
  ga_visitors   bigint   default 0,
  wa_joins      bigint   default 0,

  created_at    timestamptz default now(),

  unique (sync_date, campaign_name, src)
);

-- Index for fast date-range queries from the dashboard
create index if not exists idx_ads_sync_date on ads_campaigns (sync_date desc);
