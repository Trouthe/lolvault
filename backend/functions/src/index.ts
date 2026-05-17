import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';

admin.initializeApp();

const PADDLE_API_KEY = defineSecret('pdl_sdbx_apikey_01krnjz3gd25ypjcabf53cnttn');
const FALLBACK_PRODUCT_ID = 'pro_01krnjq9gag23958zagmrp69nx';

type BillingInterval = 'day' | 'week' | 'month' | 'year';

interface PaddlePrice {
  id: string;
  product_id: string;
  status: 'active' | 'archived';
  billing_cycle: {
    interval: BillingInterval;
    frequency: number;
  } | null;
  unit_price: {
    amount: string;
    currency_code: string;
  };
  updated_at: string;
}

interface PaddleListPricesResponse {
  data: PaddlePrice[];
}

interface PublicRecurringPrice {
  priceId: string;
  amount: string;
  amountMinor: number;
  currencyCode: string;
  interval: 'month' | 'year';
  frequency: number;
}

function parseQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function formatCurrencyFromMinor(amountMinor: number, currencyCode: string): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const majorAmount = amountMinor / 10 ** fractionDigits;
  return formatter.format(majorAmount);
}

function toPublicPrice(price: PaddlePrice): PublicRecurringPrice {
  const amountMinor = Number.parseInt(price.unit_price.amount, 10);
  if (Number.isNaN(amountMinor)) {
    throw new Error(`Invalid amount for price ${price.id}`);
  }

  if (
    !price.billing_cycle ||
    (price.billing_cycle.interval !== 'month' && price.billing_cycle.interval !== 'year')
  ) {
    throw new Error(`Invalid billing cycle for price ${price.id}`);
  }

  return {
    priceId: price.id,
    amountMinor,
    amount: formatCurrencyFromMinor(amountMinor, price.unit_price.currency_code),
    currencyCode: price.unit_price.currency_code,
    interval: price.billing_cycle.interval,
    frequency: price.billing_cycle.frequency,
  };
}

function findRecurringPrice(
  prices: PaddlePrice[],
  interval: 'month' | 'year'
): PaddlePrice | undefined {
  return prices
    .filter(
      (price) =>
        price.status === 'active' &&
        price.billing_cycle?.interval === interval &&
        price.billing_cycle.frequency === 1
    )
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
}

// Example Cloud Function - you can remove or modify this
export const helloWorld = functions.https.onRequest((request, response) => {
  functions.logger.info('Hello logs!', { structuredData: true });
  response.send('Hello from LoL Vault!');
});

export const getPaddlePremiumPricing = onRequest(
  {
    cors: true,
    secrets: [PADDLE_API_KEY],
  },
  async (request, response) => {
    if (request.method !== 'GET') {
      response.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    const queryProductId = parseQueryString(request.query.productId);
    const productId = queryProductId ?? process.env.PADDLE_PRODUCT_ID ?? FALLBACK_PRODUCT_ID;
    const paddleApiKey = PADDLE_API_KEY.value();

    if (!paddleApiKey) {
      response.status(500).json({ error: 'PADDLE_API_KEY secret is missing.' });
      return;
    }

    const url = new URL('https://api.paddle.com/prices');
    url.searchParams.set('product_id', productId);
    url.searchParams.set('recurring', 'true');
    url.searchParams.set('status', 'active');
    url.searchParams.set('per_page', '200');

    let paddleResponse: globalThis.Response;
    try {
      paddleResponse = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${paddleApiKey}`,
          Accept: 'application/json',
        },
      });
    } catch (error) {
      functions.logger.error('Paddle request failed', error);
      response.status(502).json({ error: 'Failed to connect to Paddle API.' });
      return;
    }

    if (!paddleResponse.ok) {
      const errorBody = await paddleResponse.text();
      functions.logger.error('Paddle API returned non-200', {
        status: paddleResponse.status,
        body: errorBody,
      });
      response.status(502).json({ error: 'Failed to fetch prices from Paddle API.' });
      return;
    }

    let payload: PaddleListPricesResponse;
    try {
      payload = (await paddleResponse.json()) as PaddleListPricesResponse;
    } catch (error) {
      functions.logger.error('Unable to parse Paddle pricing payload', error);
      response.status(502).json({ error: 'Received invalid response from Paddle API.' });
      return;
    }

    const monthly = findRecurringPrice(payload.data ?? [], 'month');
    const yearly = findRecurringPrice(payload.data ?? [], 'year');

    if (!monthly || !yearly) {
      response.status(404).json({
        error: 'Could not find both monthly and yearly recurring prices for the product.',
      });
      return;
    }

    response.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    response.status(200).json({
      productId,
      monthly: toPublicPrice(monthly),
      yearly: toPublicPrice(yearly),
      fetchedAt: new Date().toISOString(),
    });
  }
);
