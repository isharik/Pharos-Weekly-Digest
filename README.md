# Built for Pharos Season of AI

# Weekly Digest Agent

A scheduled digest that summarizes a wallet's or protocol's on-chain activity and highlights what changed during the reporting period.

## Video Walkthrough for getting started
https://youtu.be/kkbNdTOeoUs


## Overview

Weekly Digest Agent turns on-chain activity into a concise, recurring update. It compares key metrics with the previous period, surfaces the three most notable events, and delivers the digest through a supported channel or published page.

## Features

- Configurable schedule, with weekly reporting as the default.
- Supports a wallet or protocol as the reporting subject.
- Reports key metrics for the current period.
- Compares metrics with the previous period.
- Highlights the top three notable events.
- Delivers output through email, Telegram, Discord, or a published page, depending on configured integrations.

## Reporting Workflow

1. Configure the target wallet or protocol and reporting period.
2. Collect activity and calculate the selected metrics.
3. Compare the current period with the previous equivalent period.
4. Rank and summarize notable events.
5. Generate the digest and deliver it through the configured destination.
6. Record delivery status so failures can be diagnosed.

## Example Digest

```markdown
# Weekly On-chain Digest

- Subject: <wallet or protocol>
- Period: <start date> to <end date>
- Previous period: <start date> to <end date>

## Key Metrics

| Metric | Current Period | Previous Period | Change |
|---|---:|---:|---:|
| Transactions | — | — | — |
| Volume | — | — | — |
| Active addresses | — | — | — |

## Top 3 Events

1. <Event summary and evidence link>
2. <Event summary and evidence link>
3. <Event summary and evidence link>
```

This is a format example only; populate it with metrics supported by the implementation.

## Setup

Clone the repository:

```bash
git clone <YOUR_REPOSITORY_URL>
cd <REPOSITORY_DIRECTORY>
```

Install the project's dependencies using its package manager or dependency file. Configure the required data-provider and delivery-channel credentials through environment variables.

Example configuration placeholders:

```env
# Reporting
DIGEST_SCHEDULE=weekly
DIGEST_TIMEZONE=UTC

# Data source
# PHAROS_RPC_URL=
# MCP configuration belongs in the project's supported config.

# Delivery: configure only the provider(s) used by this project
# SMTP_HOST=
# SMTP_USER=
# SMTP_PASSWORD=
# TELEGRAM_BOT_TOKEN=
# DISCORD_WEBHOOK_URL=
```

Do not commit `.env` files or secrets. See the repository's actual configuration and startup command before running the agent.

## Scheduling and Delivery

Use the scheduler implemented by this project. If the schedule is managed externally (for example, by a deployment platform or cron), document that configuration here. Confirm the timezone and delivery destination before enabling recurring jobs.

## Reliability

- Store the reporting period associated with each digest.
- Handle rate limits and temporary data-source failures.
- Retry delivery failures safely and avoid duplicate messages.
- Distinguish zero activity from unavailable data.
- Include links or references for notable events.

## Limitations

Available metrics and event detection depend on the configured data source. Do not imply that a metric is supported unless the implementation calculates it reliably.

## Roadmap

- [ ] Add more configurable metrics
- [ ] Improve event ranking
- [ ] Add delivery-status logging
- [ ] Add tests for period-over-period comparisons

## License

Not yet Approved by the team !


