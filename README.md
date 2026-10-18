# Built for Pharos Season of AI

# Weekly Digest Agent

A React and Vite dashboard for reading Pharos EVM network state, inspecting a fetched transaction sample, composing a digest, and sending it through configured delivery channels.

## Video walkthrough

[Watch the getting started walkthrough](https://youtu.be/kkbNdTOeoUs)

## Run locally

```sh
npm install
npm run dev
npm run lint
npm run build
```

## Network access

The browser UI reads chain data through EVM JSON-RPC (`eth_chainId`, `eth_blockNumber`, `eth_gasPrice`, `eth_getBlockByNumber`, `eth_getBalance`, `eth_getTransactionCount`, and `eth_getCode`). It checks that the responding RPC chain ID matches the selected network before displaying a sync as connected. Network endpoints and chain settings are defined in `src/App.jsx`.

The configured explorer API retrieves address transaction history, with recent-block JSON-RPC scanning as a fallback. Explorer availability, endpoint CORS policy, and public RPC rate limits can affect data coverage. The UI reports a fetched sample; it does not index a complete weekly history or calculate true calendar-period comparisons.

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
- Compare the earlier and later halves of the fetched sample. These are sample comparisons, not true period-over-period metrics.
- Prepare a digest for email, Telegram, Discord, or a published report, depending on configured integrations.
- Configure a desired cadence. The UI does not run a persistent scheduler; automatic execution requires an external scheduler and a deployed backend.

Delivery integrations run from the browser and require user-provided webhook credentials or relay configuration. Treat browser-stored settings as accessible to anyone who can use that browser profile. The Brevo key is held in session storage. Do not use a production secret in the client. An email receipt records the provider response and is not independent proof of inbox delivery. Apps Script must be deployed and authorized before it can send mail.

## Validation

Run `npm run lint` and `npm run build` to check the frontend. These checks do not verify live RPC, explorer, MCP, or delivery service availability.
