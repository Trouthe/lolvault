import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';

admin.initializeApp();

const PADDLE_API_KEY = defineSecret('pdl_sdbx_apikey_01krnjz3gd25ypjcabf53cnttn');
const FALLBACK_PREMIUM_PRICE_ID = 'pri_01ks089v0ytt2pd49ryqcbd5xd';

interface PaddlePrice {
  id: string;
  product_id: string;
  status: 'active' | 'archived';
  unit_price: {
    amount: string;
    currency_code: string;
  };
}

interface PaddleGetPriceResponse {
  data: PaddlePrice;
}

interface PublicOneTimePrice {
  priceId: string;
  amount: string;
  amountMinor: number;
  currencyCode: string;
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

function toPublicPrice(price: PaddlePrice): PublicOneTimePrice {
  const amountMinor = Number.parseInt(price.unit_price.amount, 10);
  if (Number.isNaN(amountMinor)) {
    throw new Error(`Invalid amount for price ${price.id}`);
  }

  return {
    priceId: price.id,
    amountMinor,
    amount: formatCurrencyFromMinor(amountMinor, price.unit_price.currency_code),
    currencyCode: price.unit_price.currency_code,
  };
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

    const queryPriceId = parseQueryString(request.query.priceId);
    const priceId =
      queryPriceId ?? process.env.PADDLE_EARLY_SUPPORTER_PRICE_ID ?? FALLBACK_PREMIUM_PRICE_ID;
    const paddleApiKey = PADDLE_API_KEY.value();

    if (!paddleApiKey) {
      response.status(500).json({ error: 'PADDLE_API_KEY secret is missing.' });
      return;
    }

    const url = new URL(`https://api.paddle.com/prices/${priceId}`);

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

    let payload: PaddleGetPriceResponse;
    try {
      payload = (await paddleResponse.json()) as PaddleGetPriceResponse;
    } catch (error) {
      functions.logger.error('Unable to parse Paddle pricing payload', error);
      response.status(502).json({ error: 'Received invalid response from Paddle API.' });
      return;
    }

    const premiumPrice = payload.data;
    if (!premiumPrice || premiumPrice.status !== 'active') {
      response.status(404).json({
        error: 'Could not find an active one-time premium price for the requested ID.',
      });
      return;
    }

    response.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    response.status(200).json({
      productId: premiumPrice.product_id,
      premium: toPublicPrice(premiumPrice),
      offerLabel: 'Early supporter one-time price',
      fetchedAt: new Date().toISOString(),
    });
  }
);
