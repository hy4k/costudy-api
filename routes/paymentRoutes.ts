/**
 * CoStudy API - Payment Routes
 * Handles Razorpay integration for subscriptions and credits
 */

import express from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();

// Razorpay configuration (from env)
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('[Payment] Razorpay credentials not configured');
}

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Razorpay SDK initialization
 */
const Razorpay = require('razorpay');
const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

/**
 * Middleware: Verify JWT token from Supabase Auth
 */
const authenticateUser = async (req: any, res: any, next: any) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = data.user;
    next();
  } catch (error) {
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

/**
 * POST /api/payment/create-order
 * Create Razorpay order
 */
router.post('/create-order', authenticateUser, async (req: any, res: any) => {
  try {
    const { amount, currency, description } = req.body;
    const userId = req.user.id;

    if (!amount || !currency) {
      return res.status(400).json({ error: 'Amount and currency required' });
    }

    // Create Razorpay order
    const options = {
      amount: amount, // Amount in paise
      currency: currency,
      receipt: `order_${Date.now()}`,
      notes: {
        user_id: userId,
        description: description || 'CoStudy Payment'
      }
    };

    const order = await razorpay.orders.create(options);

    // Save order to database
    await supabase.from('payment_orders').insert({
      user_id: userId,
      razorpay_order_id: order.id,
      amount: amount / 100, // Store in rupees
      currency: currency,
      status: 'CREATED',
      description: description,
      created_at: new Date().toISOString()
    });

    res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (error: any) {
    console.error('[Payment] Create order error:', error);
    res.status(500).json({ error: error.message || 'Failed to create order' });
  }
});

/**
 * POST /api/payment/verify
 * Verify Razorpay payment signature
 */
router.post('/verify', authenticateUser, async (req: any, res: any) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const userId = req.user.id;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    // Verify signature
    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET!)
      .update(sign.toString())
      .digest('hex');

    const isValid = expectedSign === razorpay_signature;

    if (!isValid) {
      // Mark order as failed
      await supabase
        .from('payment_orders')
        .update({ status: 'FAILED' })
        .eq('razorpay_order_id', razorpay_order_id);

      return res.status(400).json({ verified: false, error: 'Invalid signature' });
    }

    // Update order status
    const { data: order } = await supabase
      .from('payment_orders')
      .update({
        status: 'PAID',
        razorpay_payment_id,
        razorpay_signature,
        verified: true,
        paid_at: new Date().toISOString()
      })
      .eq('razorpay_order_id', razorpay_order_id)
      .select()
      .single();

    if (!order) {
      return res.status(404).json({ verified: false, error: 'Order not found' });
    }

    // Check if this is a referral user's first payment
    const { data: referralUsage } = await supabase
      .from('referral_usage')
      .select('*')
      .eq('referred_user_id', userId)
      .eq('status', 'PENDING')
      .single();

    if (referralUsage) {
      // Complete referral
      await supabase
        .from('referral_usage')
        .update({
          status: 'COMPLETED',
          completed_at: new Date().toISOString(),
          conversion_amount: order.amount
        })
        .eq('id', referralUsage.id);

      // Add reward to referrer's wallet
      const { data: referrerProfile } = await supabase
        .from('user_profiles')
        .select('costudy_status')
        .eq('id', referralUsage.referrer_id)
        .single();

      const currentBalance = referrerProfile?.costudy_status?.walletBalance || 0;
      const newBalance = currentBalance + referralUsage.reward_amount;

      await supabase
        .from('user_profiles')
        .update({
          costudy_status: {
            ...referrerProfile?.costudy_status,
            walletBalance: newBalance
          }
        })
        .eq('id', referralUsage.referrer_id);

      // Record transaction
      await supabase.from('wallet_transactions').insert({
        user_id: referralUsage.referrer_id,
        type: 'REWARD',
        amount: referralUsage.reward_amount,
        description: `Referral reward for ${userId.slice(0, 8)}`,
        reference_type: 'REFERRAL',
        reference_id: referralUsage.id,
        balance_after: newBalance,
        created_at: new Date().toISOString()
      });

      // Send notification
      await supabase.from('notifications').insert({
        user_id: referralUsage.referrer_id,
        type: 'REWARD',
        content: `🎉 You earned ₹${referralUsage.reward_amount} from a successful referral!`,
        link: '/profile?tab=wallet',
        is_read: false,
        created_at: new Date().toISOString()
      });
    }

    res.json({
      verified: true,
      transactionId: order.id,
      amount: order.amount
    });
  } catch (error: any) {
    console.error('[Payment] Verify error:', error);
    res.status(500).json({ verified: false, error: error.message });
  }
});

/**
 * POST /api/payment/refund
 * Initiate refund for a payment (admin only)
 */
router.post('/refund', authenticateUser, async (req: any, res: any) => {
  try {
    const { payment_id, amount } = req.body;
    const userId = req.user.id;

    // Check if user is admin
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('role, costudy_status')
      .eq('id', userId)
      .single();

    const isAdmin = userProfile?.role === 'ADMIN' || userProfile?.costudy_status?.isAdmin === true;

    if (!isAdmin) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Initiate refund via Razorpay
    const refund = await razorpay.payments.refund(payment_id, {
      amount: amount, // Amount in paise
      speed: 'normal'
    });

    // Update order status
    await supabase
      .from('payment_orders')
      .update({ status: 'REFUNDED' })
      .eq('razorpay_payment_id', payment_id);

    res.json({
      success: true,
      refund_id: refund.id,
      status: refund.status
    });
  } catch (error: any) {
    console.error('[Payment] Refund error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/payment/orders
 * Get user's payment history
 */
router.get('/orders', authenticateUser, async (req: any, res: any) => {
  try {
    const userId = req.user.id;
    const { limit = 20, offset = 0 } = req.query;

    const { data: orders, error } = await supabase
      .from('payment_orders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ orders: orders || [] });
  } catch (error: any) {
    console.error('[Payment] Orders error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
