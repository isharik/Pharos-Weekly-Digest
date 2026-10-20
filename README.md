# Built for Pharos Season of AI

# Weekly Digest Agent

A React and Vite dashboard for reading Pharos EVM network state, inspecting a fetched transaction sample, composing a digest, and sending it through configured delivery channels.

## Video walkthrough

[Watch the getting started walkthrough](https://youtu.be/kkbNdTOeoUs)

## Run locally

```sh
npm install
copy .env.example .env
# Set DIGEST_API_TOKEN and SMTP credentials in .env before starting the API.
npm run lint
npm run build
# Start the persistent API service:
npm run dev:server
# In another terminal:
npm run dev
```

## Network access

The browser UI reads chain data through EVM JSON-RPC (`eth_chainId`, `eth_blockNumber`, `eth_gasPrice`, `eth_getBlockByNumber`, `eth_getBalance`, `eth_getTransactionCount`, and `eth_getCode`). It checks that the responding RPC chain ID matches the selected network before displaying a sync as connected. Network endpoints and chain settings are defined in `src/App.jsx`.

The interactive dashboard uses a fetched recent transaction sample for the live scanner. The scheduler service uses the explorer's paginated address transaction endpoint to retrieve a complete daily, weekly, or 14-day window, then compares it with the immediately preceding interval of the same length. It refuses to send when pagination reaches its safety limit before covering the previous period. Explorer outages or unsupported response fields are recorded as failed runs rather than reported as zero activity.

## Scheduler API and SMTP delivery

The persistent Node service in `server/` stores schedule configuration and run history in `.data/scheduler.json`. Keep that directory on persistent storage when deploying; run one scheduler instance and keep it running. Configure `DIGEST_API_TOKEN` with at least 32 random characters, `SOCIALSCAN_API_KEY` for Pharos history, and `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`. SocialScan keys are issued through [SocialScan Developer](https://developer.socialscan.io/). The browser's Schedule panel uses the API token and the recipient from its Email panel. The token stays in session storage; SocialScan and SMTP credentials never reach the browser.

The API listens on port `8787` by default. Vite proxies `/api` to it in development. For a separate production frontend, set `VITE_DIGEST_API_URL` to the deployed API origin and `WEB_ORIGIN` on the API to the exact frontend origin. Protect the token and use HTTPS. Set `DIGEST_DATA_FILE` to a path on a persistent disk if the default `.data/` path is ephemeral.

Available authenticated endpoints are `GET /api/status`, `GET /api/history`, `PUT /api/schedule`, and `POST /api/run`. Scheduled and manual runs use the SocialScan Etherscan-compatible transaction history API for the selected Pharos network, send an email through SMTP, and save an audit record with the accepted recipient and report. Configure SMTP with a provider account that authorizes the `SMTP_FROM` sender. No provider credentials are committed to the repository.

## Pharos MCP for agent clients

The dashboard is a browser app and does not itself speak MCP. For an MCP-compatible IDE or agent, Pharos publishes a read-only Streamable HTTP server at `https://mcp.pharos.xyz/mcp`. Add this to that client's MCP server configuration:

```json
{
  "mcpServers": {
    "pharos": {
      "type": "http",
      "url": "https://mcp.pharos.xyz/mcp"
    }
  }
}
```

The MCP server exposes chain information, blocks, balances, transaction lookups, code, logs, and other read tools. Its hosted transaction-broadcast tool is disabled. The dashboard's wallet actions use the injected EIP-1193 provider; digest reads use JSON-RPC. MCP is an agent-tool protocol, not a replacement for either browser API.

## Features and limits

- Configure a wallet or protocol address and select a supported network.
- Inspect live balance, nonce, block, gas price, recent transactions, and notable events.
- Scan recent blocks and prepare an on-demand digest through the interactive dashboard.
- Run authenticated daily, weekly, or 14-day schedules in the persistent Node service.
- Compare exact timestamp windows for transaction count, native transfer volume, counterparties, and reported fees.
- Deliver scheduled and manual scheduler reports through server-side SMTP. Existing Telegram and Discord integrations remain available for browser-triggered dispatch.

The SMTP run history distinguishes accepted messages from failed sends; SMTP acceptance is not proof of final inbox delivery. The interactive dashboard's older email relays remain separate from the scheduler's SMTP channel.

## Validation

Run `npm run lint` and `npm run build` to check the frontend. These checks do not verify live RPC, explorer, MCP, or SMTP availability. Scheduled email requires a continuously running backend and valid SMTP credentials.
