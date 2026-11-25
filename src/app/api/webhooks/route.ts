import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { claimPolarWebhookId, releasePolarWebhookId, verifyPolarWebhookSignature } from '@/lib/polar-webhook';

// Initialize Supabase client with service role key for admin access
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: Request) {
  let claimedId: string | null = null;
  try {
    const webhookSecret = process.env.POLAR_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[Polar Webhook] POLAR_WEBHOOK_SECRET is not configured');
      return NextResponse.json(
        { error: 'Webhook verification unavailable' },
        { status: 503 }
      );
    }

    const payload = await request.text();

    const isValid = verifyPolarWebhookSignature(
      payload,
      {
        id: request.headers.get('webhook-id'),
        timestamp: request.headers.get('webhook-timestamp'),
        signature: request.headers.get('webhook-signature'),
      },
      webhookSecret
    );

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      );
    }

    const webhookId = request.headers.get('webhook-id')!;
    if (!claimPolarWebhookId(webhookId)) {
      console.warn('[Polar Webhook] Ignored replayed webhook-id');
      return NextResponse.json({ received: true, status: 'duplicate' });
    }
    claimedId = webhookId;

    const event = JSON.parse(payload);
    console.log('Received webhook event:', event.type);
    
    // DISABLED: Subscription functionality not currently used
    // Tables: subscriptions, pending_subscriptions have been removed
    // Uncomment and restore tables if subscriptions are needed in the future
    
    /*
    switch (event.type) {
      case 'subscription.created':
      case 'subscription.updated':
        await handleSubscriptionEvent(event.data);
        break;
      
      case 'checkout.completed':
        await handleCheckoutEvent(event.data);
        break;
      
      default:
        console.log('Unhandled event type:', event.type);
    }
    */

    console.log('Webhook received but subscription handling is disabled');
    return NextResponse.json({ received: true, status: 'subscription_disabled' });
  } catch (error) {
    if (claimedId) releasePolarWebhookId(claimedId);
    console.error('Error processing webhook:', error);
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    );
  }
}

// DISABLED: Subscription functionality not currently used
// Uncomment if subscriptions are needed in the future
/*
async function handleSubscriptionEvent(data: any) {
  const {
    id: polar_subscription_id,
    status,
    customer: { email }
  } = data;

  // Get user_id from auth.users using email
  const { data: userData, error: userError } = await supabase
    .from('auth.users')
    .select('id')
    .eq('email', email)
    .single();

  if (userError) {
    console.error('Error finding user:', userError);
    return;
  }

  const user_id = userData.id;
  
  // Determine plan type based on the subscription data
  const plan_type = data.plan || 'pro';

  // Upsert subscription record
  const { error: subscriptionError } = await supabase
    .from('subscriptions')
    .upsert({
      user_id,
      polar_subscription_id,
      plan_type,
      status,
      payment_provider: 'polar',
      updated_at: new Date().toISOString()
    });

  if (subscriptionError) {
    console.error('Error updating subscription:', subscriptionError);
  }
}

async function handleCheckoutEvent(data: any) {
  // Store the checkout data temporarily
  // This will be used when the user signs up
  const { error } = await supabase
    .from('pending_subscriptions')
    .insert({
      checkout_id: data.id,
      email: data.customer.email,
      plan_type: data.metadata?.plan || 'pro',
      status: 'pending',
      created_at: new Date().toISOString()
    });

  if (error) {
    console.error('Error storing pending subscription:', error);
  }
}
*/ 