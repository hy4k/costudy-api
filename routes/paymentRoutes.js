/**
 * CoStudy API - Payment Routes (ESM, used by server.js in production)
 */
import express from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Razorpay = require('razorpay');

const router = express.Router();

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('[Payment] Razorpay credentials not configured');
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const razorpay =
  RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET,
      })
    : null;

const authenticateUser = async (req, res, next) => {
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
  } catch {
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

router.post('/create-order', authenticateUser, async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: 'Payment provider not configured' });
    }
    const { amount, currency, description } = req.body;
    const userId = req.user.id;

    if (!amount || !currency) {
      return res.status(400).json({ error: 'Amount and currency required' });
    }

    const options = {
      amount,
      currency,
      receipt: `order_${Date.now()}`,
      notes: {
        user_id: userId,
        description: description || 'CoStudy Payment',
      },
    };

    const order = await razorpay.orders.create(options);

    await supabase.from('payment_orders').insert({
      user_id: userId,
      razorpay_order_id: order.id,
      amount: amount / 100,
      currency,
      status: 'CREATED',
      description,
      created_at: new Date().toISOString(),
    });

    res.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (error) {
    console.error('[Payment] Create order error:', error);
    res.status(500).json({ error: error.message || 'Failed to create order' });
  }
});

router.post('/verify', authenticateUser, async (req, res) => {
  try {
    if (!RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ verified: false, error: 'Payment provider not configured' });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const userId = req.user.id;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    const sign = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSign = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(sign.toString())
      .digest('hex');

    const isValid = expectedSign === razorpay_signature;

    if (!isValid) {
      await supabase
        .from('payment_orders')
        .update({ status: 'FAILED' })
        .eq('razorpay_order_id', razorpay_order_id);

      return res.status(400).json({ verified: false, error: 'Invalid signature' });
    }

    const { data: order } = await supabase
      .from('payment_orders')
      .update({
        status: 'PAID',
        razorpay_payment_id,
        razorpay_signature,
        verified: true,
        paid_at: new Date().toISOString(),
      })
      .eq('razorpay_order_id', razorpay_order_id)
      .select()
      .single();

    if (!order) {
      return res.status(404).json({ verified: false, error: 'Order not found' });
    }

    const { data: referralUsage } = await supabase
      .from('referral_usage')
      .select('*')
      .eq('referred_user_id', userId)
      .eq('status', 'PENDING')
      .single();

    if (referralUsage) {
      await supabase
        .from('referral_usage')
        .update({
          status: 'COMPLETED',
          completed_at: new Date().toISOString(),
          conversion_amount: order.amount,
        })
        .eq('id', referralUsage.id);

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
            walletBalance: newBalance,
          },
        })
        .eq('id', referralUsage.referrer_id);

      await supabase.from('wallet_transactions').insert({
        user_id: referralUsage.referrer_id,
        type: 'REWARD',
        amount: referralUsage.reward_amount,
        description: `Referral reward for ${userId.slice(0, 8)}`,
        reference_type: 'REFERRAL',
        reference_id: referralUsage.id,
        balance_after: newBalance,
        created_at: new Date().toISOString(),
      });

      await supabase.from('notifications').insert({
        user_id: referralUsage.referrer_id,
        type: 'REWARD',
        content: `You earned ₹${referralUsage.reward_amount} from a successful referral!`,
        link: '/profile?tab=wallet',
        is_read: false,
        created_at: new Date().toISOString(),
      });
    }

    res.json({
      verified: true,
      transactionId: order.id,
      amount: order.amount,
    });
  } catch (error) {
    console.error('[Payment] Verify error:', error);
    res.status(500).json({ verified: false, error: error.message });
  }
});

router.post('/refund', authenticateUser, async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: 'Payment provider not configured' });
    }
    const { payment_id, amount } = req.body;
    const userId = req.user.id;

    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('role, costudy_status')
      .eq('id', userId)
      .single();

    const isAdmin =
      userProfile?.role === 'ADMIN' || userProfile?.costudy_status?.isAdmin === true;

    if (!isAdmin) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const refund = await razorpay.payments.refund(payment_id, {
      amount,
      speed: 'normal',
    });

    await supabase
      .from('payment_orders')
      .update({ status: 'REFUNDED' })
      .eq('razorpay_payment_id', payment_id);

    res.json({
      success: true,
      refund_id: refund.id,
      status: refund.status,
    });
  } catch (error) {
    console.error('[Payment] Refund error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/orders', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Number(req.query.limit) || 20;
    const offset = Number(req.query.offset) || 0;

    const { data: orders, error } = await supabase
      .from('payment_orders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({ orders: orders || [] });
  } catch (error) {
    console.error('[Payment] Orders error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
