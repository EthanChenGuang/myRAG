const POLAR_API_BASE = process.env.NODE_ENV === 'production'
  ? 'https://polar.sh'
  : 'https://sandbox.polar.sh';

interface PolarCheckoutLinkResponse {
  id: string;
  url: string;
}

export const getPolarCheckoutUrl = async (priceId: string, successUrl: string, cancelUrl: string) => {
  // Get the appropriate checkout link based on the price ID
  let checkoutLink = '';
  
  if (priceId === process.env.NEXT_PUBLIC_POLAR_PRICE_ID_PRO) {
    checkoutLink = process.env.NEXT_PUBLIC_POLAR_CHECKOUT_PRO || '';
  } else if (priceId === process.env.NEXT_PUBLIC_POLAR_PRICE_ID_ENTERPRISE) {
    checkoutLink = process.env.NEXT_PUBLIC_POLAR_CHECKOUT_ENTERPRISE || '';
  }

  if (!checkoutLink) {
    throw new Error('Checkout link not found for the given price ID');
  }

  try {
    // Add success and cancel URLs as query parameters to the checkout link
    const urlWithParams = new URL(checkoutLink);
    urlWithParams.searchParams.append('success_url', successUrl);
    urlWithParams.searchParams.append('cancel_url', cancelUrl);
    urlWithParams.searchParams.append('source', 'easyrag_template');

    return urlWithParams.toString();
  } catch (error) {
    console.error('Error creating checkout link:', error);
    throw error;
  }
};
