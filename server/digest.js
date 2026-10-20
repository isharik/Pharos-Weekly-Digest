import { randomUUID } from 'node:crypto';

export const NETWORKS = {
  atlantic: {
    key: 'atlantic',
    name: 'Pharos Atlantic Testnet',
    chainId: 688689,
    chainIdHex: '0xa8231',
    symbol: 'PHRS',
    rpcUrls: ['https://atlantic.dplabs-internal.com', 'https://rpc.evm.pharos.testnet.cosmostation.io'],
    explorerApiUrl: 'https://api.socialscan.io/pharos-atlantic-testnet/v1/developer/api',
    explorer: 'https://atlantic.pharosscan.xyz'
  },
  mainnet: {
    key: 'mainnet',
    name: 'Pharos Pacific Mainnet',
    chainId: 1672,
    chainIdHex: '0x688',
    symbol: 'PROS',
    rpcUrls: ['https://rpc.pharos.xyz', 'https://pharos.drpc.org'],
    explorerApiUrl: 'https://api.socialscan.io/pharos-mainnet/v1/developer/api',
    explorer: 'https://scan.pharos.xyz'
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = { daily: 1, weekly: 7, biweekly: 14 };
const DAY_NUMBERS = { Sunday: 0, Monday: 1, Friday: 5 };
const verifiedRpcEndpoints = new Set();

export function periodLengthMs(frequency) {
  const days = PERIOD_DAYS[frequency];
  if (!days) throw new Error('Frequency must be daily, weekly, or biweekly.');
  return days * DAY_MS;
}

export function nextRunAfter(schedule, from = new Date()) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const candidate = new Date(from);
  candidate.setUTCHours(hour, minute, 0, 0);

  if (schedule.frequency === 'daily') {
    if (candidate <= from) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate;
  }

  const targetDay = DAY_NUMBERS[schedule.day];
  if (targetDay === undefined) throw new Error('Delivery day must be Sunday, Monday, or Friday.');
  let offset = (targetDay - candidate.getUTCDay() + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + offset);
  if (candidate <= from) candidate.setUTCDate(candidate.getUTCDate() + 7);
  return candidate;
}

export function followingRun(schedule, previousRun) {
  const intervalDays = schedule.frequency === 'daily' ? 1 : schedule.frequency === 'weekly' ? 7 : 14;
  return new Date(new Date(previousRun).getTime() + intervalDays * DAY_MS);
}

export function reportWindow(frequency, at = new Date()) {
  const periodMs = periodLengthMs(frequency);
  const currentTo = new Date(at);
  const currentFrom = new Date(currentTo.getTime() - periodMs);
  const previousTo = currentFrom;
  const previousFrom = new Date(previousTo.getTime() - periodMs);
  return { currentFrom, currentTo, previousFrom, previousTo };
}

function asTimestamp(value) {
  if (!value) return NaN;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  return date.getTime();
}

function parseWei(value) {
  try {
    return BigInt(value || '0');
  } catch {
    return 0n;
  }
}

function amountFromWei(wei, decimals = 6) {
  const divisor = 10n ** 18n;
  const whole = wei / divisor;
  const fraction = (wei % divisor).toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function percentage(current, previous) {
  if (previous === 0n) return current === 0n ? '0.0' : null;
  const delta = (current - previous) * 1000n;
  const sign = delta < 0n ? '-' : '';
  const magnitude = delta < 0n ? -delta : delta;
  const tenths = (magnitude + previous / 2n) / previous;
  return `${sign}${tenths / 10n}.${tenths % 10n}`;
}

function normalizeTransaction(item, network) {
  const hash = item.hash || item.transactionHash;
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash || '')) return null;
  const from = (item.from?.hash || item.from || '').toLowerCase();
  const to = (item.to?.hash || item.to || '').toLowerCase();
  const valueWei = parseWei(item.value);
  const rawFee = item.fee?.value ?? item.fee;
  const feeWei = rawFee !== undefined && rawFee !== null
    ? parseWei(rawFee)
    : (item.gas_used || item.gasUsed) && (item.gas_price || item.gasPrice)
      ? parseWei(item.gas_used || item.gasUsed) * parseWei(item.gas_price || item.gasPrice)
      : null;
  const timestamp = asTimestamp(item.timestamp || item.timestamp_iso || item.timeStamp || item.block?.timestamp);
  const input = item.raw_input || item.input || '0x';
  const blockNumber = Number(item.block_number || item.blockNumber || item.block?.number || 0);
  return {
    hash,
    from,
    to,
    valueWei: valueWei.toString(),
    feeWei: feeWei?.toString() ?? null,
    timestamp,
    blockNumber,
    successful: String(item.isError ?? '0') !== '1' && String(item.txreceipt_status ?? '1') !== '0',
    method: item.method || (input === '0x' ? 'Native transfer' : `Contract call ${input.slice(0, 10)}`),
    explorerUrl: `${network.explorer}/tx/${hash}`
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}${detail ? `: ${detail}` : ''}`);
  }
  return response.json();
}

async function rpcAtEndpoint(endpoint, method, params = []) {
  const id = randomUUID();
  const response = await fetchJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  if (response.id !== id || response.jsonrpc !== '2.0' || response.error || !('result' in response)) {
    throw new Error(response.error?.message || 'Invalid JSON-RPC response');
  }
  return response.result;
}

async function rpc(network, method, params = []) {
  const failures = [];
  for (const endpoint of network.rpcUrls) {
    try {
      const verificationKey = `${network.key}:${endpoint}`;
      if (!verifiedRpcEndpoints.has(verificationKey)) {
        const chainId = await rpcAtEndpoint(endpoint, 'eth_chainId');
        if (String(chainId).toLowerCase() !== network.chainIdHex) {
          throw new Error(`Wrong chain ID ${chainId}; expected ${network.chainId}.`);
        }
        verifiedRpcEndpoints.add(verificationKey);
        if (method === 'eth_chainId') return chainId;
      }
      return await rpcAtEndpoint(endpoint, method, params);
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error(`All ${network.name} RPC endpoints failed for ${method}: ${failures.join('; ')}`);
}

async function readChain(network) {
  const chainId = await rpc(network, 'eth_chainId');
  if (String(chainId).toLowerCase() !== network.chainIdHex) {
    throw new Error(`Wrong chain ID ${chainId}; expected ${network.chainId} for ${network.name}.`);
  }
  const latestBlock = Number(BigInt(await rpc(network, 'eth_blockNumber')));
  if (!Number.isSafeInteger(latestBlock) || latestBlock < 1) throw new Error('RPC returned an invalid latest block.');
  return latestBlock;
}

async function blockAtOrAfter(network, latestBlock, targetTime) {
  let low = 0;
  let high = latestBlock + 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (mid > latestBlock) break;
    const block = await rpc(network, 'eth_getBlockByNumber', [`0x${mid.toString(16)}`, false]);
    if (!block?.timestamp) throw new Error(`RPC could not return block ${mid} while locating a period boundary.`);
    if (Number(BigInt(block.timestamp)) * 1000 >= targetTime) high = mid;
    else low = mid + 1;
  }
  return low;
}

async function fetchTransactions(network, address, fromBlock, toBlock) {
  const apiKey = process.env.SOCIALSCAN_API_KEY;
  if (!apiKey) throw new Error('Set SOCIALSCAN_API_KEY on the server to query Pharos transaction history.');

  const transactions = new Map();
  let oldestSeen = Infinity;
  let pageCount = 0;
  const pageSize = 100;
  let exhausted = false;

  for (let rangeStart = fromBlock; rangeStart <= toBlock; rangeStart += 99_999) {
    const rangeEnd = Math.min(rangeStart + 99_998, toBlock);
    let page = 1;
    while (page <= 200) {
      const url = new URL(network.explorerApiUrl);
      for (const [key, value] of Object.entries({
        module: 'account', action: 'txlist', address,
        startblock: String(rangeStart), endblock: String(rangeEnd), page: String(page),
        offset: String(pageSize), sort: 'asc'
      })) url.searchParams.set(key, value);

      const data = await fetchJson(url.toString(), { headers: { 'x-api-key': apiKey } });
      if (!Array.isArray(data.result)) {
        if (String(data.status) === '0' && /no transactions found/i.test(String(data.message || JSON.stringify(data.result)))) {
          exhausted = true;
          break;
        }
        throw new Error(`SocialScan history API error: ${data.message || JSON.stringify(data.result)}`);
      }
      if (data.result.length === 0) {
        exhausted = true;
        break;
      }

      let parsedCount = 0;
      for (const item of data.result) {
        const tx = normalizeTransaction(item, network);
        if (!tx || !Number.isFinite(tx.timestamp)) continue;
        parsedCount++;
        oldestSeen = Math.min(oldestSeen, tx.timestamp);
        transactions.set(tx.hash, tx);
      }
      if (parsedCount === 0) throw new Error('SocialScan records did not include parseable hashes and timestamps.');
      pageCount++;
      if (data.result.length < pageSize) {
        exhausted = true;
        break;
      }
      page++;
    }
    if (page > 200) throw new Error(`SocialScan page limit reached in block range ${rangeStart}–${rangeEnd}; comparison would be incomplete.`);
  }

  return { transactions: [...transactions.values()], pageCount, exhausted, oldestSeen };
}

function summarize(transactions, from, to, subjectAddress) {
  const selected = transactions.filter((tx) => tx.timestamp >= from.getTime() && tx.timestamp < to.getTime());
  const volumeWei = selected.filter((tx) => tx.success).reduce((sum, tx) => sum + BigInt(tx.valueWei), 0n);
  const knownFeeTransactions = selected.filter((tx) => tx.feeWei !== null);
  const feeWei = knownFeeTransactions.reduce((sum, tx) => sum + BigInt(tx.feeWei), 0n);
  const counterparties = new Set();
  for (const tx of selected) {
    if (tx.from && tx.from !== subjectAddress.toLowerCase()) counterparties.add(tx.from);
    if (tx.to && tx.to !== subjectAddress.toLowerCase()) counterparties.add(tx.to);
  }
  return {
    transactionCount: selected.length,
    counterparties: counterparties.size,
    volumeWei: volumeWei.toString(),
    volume: amountFromWei(volumeWei),
    feesWei: knownFeeTransactions.length === selected.length ? feeWei.toString() : null,
    fees: knownFeeTransactions.length === selected.length ? amountFromWei(feeWei) : null,
    feesCoverage: { knownTransactions: knownFeeTransactions.length, totalTransactions: selected.length }
  };
}

export async function createDigestReport(config, at = new Date()) {
  const network = NETWORKS[config.network];
  if (!network) throw new Error('Unsupported network.');
  if (!/^0x[a-fA-F0-9]{40}$/.test(config.address || '')) throw new Error('Enter a valid EVM address.');
  const window = reportWindow(config.frequency, at);
  const latestBlock = await readChain(network);
  const previousFromBlock = await blockAtOrAfter(network, latestBlock, window.previousFrom.getTime());
  const currentFromBlock = await blockAtOrAfter(network, latestBlock, window.currentFrom.getTime());
  const currentToBlockExclusive = await blockAtOrAfter(network, latestBlock, window.currentTo.getTime());
  const fetched = await fetchTransactions(network, config.address, previousFromBlock, currentToBlockExclusive - 1);
  const earlier = summarize(fetched.transactions, window.previousFrom, window.previousTo, config.address);
  const current = summarize(fetched.transactions, window.currentFrom, window.currentTo, config.address);
  const allTx = fetched.transactions.filter((tx) => tx.timestamp >= window.currentFrom.getTime() && tx.timestamp < window.currentTo.getTime());
  const notableEvents = [...allTx]
    .sort((left, right) => {
      const leftValue = BigInt(left.valueWei);
      const rightValue = BigInt(right.valueWei);
      return rightValue > leftValue ? 1 : rightValue < leftValue ? -1 : right.timestamp - left.timestamp;
    })
    .slice(0, 3)
    .map(({ hash, from, to, valueWei, timestamp, blockNumber, method, explorerUrl }) => ({
      hash,
      from,
      to,
      value: amountFromWei(BigInt(valueWei)),
      timestamp: new Date(timestamp).toISOString(),
      blockNumber,
      method,
      explorerUrl
    }));

  return {
    generatedAt: at.toISOString(),
    network: network.key,
    networkName: network.name,
    chainId: network.chainId,
    symbol: network.symbol,
    address: config.address,
    label: config.label || config.address,
    frequency: config.frequency,
    window: Object.fromEntries(Object.entries(window).map(([key, date]) => [key, date.toISOString()])),
    comparison: {
      previous: earlier,
      current,
      deltaPercent: {
        transactionCount: percentage(BigInt(current.transactionCount), BigInt(earlier.transactionCount)),
        counterparties: percentage(BigInt(current.counterparties), BigInt(earlier.counterparties)),
        volume: percentage(BigInt(current.volumeWei), BigInt(earlier.volumeWei)),
        fees: current.feesWei === null || earlier.feesWei === null
          ? null
          : percentage(BigInt(current.feesWei), BigInt(earlier.feesWei))
      }
    },
    coverage: {
      complete: true,
      explorerPages: fetched.pageCount,
      blockRange: { from: previousFromBlock, to: currentToBlockExclusive - 1 },
      currentPeriodBlocks: { from: currentFromBlock, to: currentToBlockExclusive - 1 },
      latestBlock
    },
    notableEvents
  };
}

export function renderDigestText(report) {
  const { current, previous, deltaPercent } = report.comparison;
  const pct = (key) => deltaPercent[key] === null ? 'new activity (previous period was zero)' : `${deltaPercent[key]}%`;
  const lines = [
    `${report.label} · ${report.networkName} ${report.frequency} digest`,
    `Address: ${report.address}`,
    `Current period: ${report.window.currentFrom} through ${report.window.currentTo}`,
    `Previous period: ${report.window.previousFrom} through ${report.window.previousTo}`,
    '',
    `Transactions: ${current.transactionCount} vs ${previous.transactionCount} (${pct('transactionCount')})`,
    `Native volume: ${current.volume} ${report.symbol} vs ${previous.volume} ${report.symbol} (${pct('volume')})`,
    `Counterparties: ${current.counterparties} vs ${previous.counterparties} (${pct('counterparties')})`,
    `Fees: ${current.fees === null ? 'unavailable' : `${current.fees} ${report.symbol}`} vs ${previous.fees === null ? 'unavailable' : `${previous.fees} ${report.symbol}`} (${deltaPercent.fees === null ? (current.fees === null || previous.fees === null ? 'unavailable' : 'new activity') : pct('fees')})`,
    '',
    'Notable current-period events:',
    ...(report.notableEvents.length ? report.notableEvents.map((event, index) => `${index + 1}. ${event.method} · ${event.value} ${report.symbol} · block ${event.blockNumber} · ${event.explorerUrl}`) : ['No transactions in the current period.']),
    '',
    `Explorer pages read: ${report.coverage.explorerPages}; queried blocks ${report.coverage.blockRange.from}–${report.coverage.blockRange.to} (latest ${report.coverage.latestBlock}).`,
    `Generated ${report.generatedAt}`
  ];
  return lines.join('\n');
}
