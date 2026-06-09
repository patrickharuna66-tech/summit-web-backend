const express    = require('express');
const cors       = require('cors');
const { Sequelize, DataTypes, Op } = require('sequelize');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const axios      = require('axios');
const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'https://summit-web-frontend.onrender.com',
    'http://localhost:3000',
    'http://localhost:5500',
  ],
  credentials: true,
}));
app.use(express.json());

// ─── DATABASE ─────────────────────────────────────────────────

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
});

// ─── MODELS ───────────────────────────────────────────────────

const User = sequelize.define('User', {
  id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name:     { type: DataTypes.STRING, allowNull: false },
  email:    { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
});

const Subscription = sequelize.define('Subscription', {
  id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  plan:           { type: DataTypes.ENUM('essential','growth','360','custom','course'), allowNull: false },
  status:         { type: DataTypes.ENUM('active','inactive','cancelled'), defaultValue: 'inactive' },
  startDate:      { type: DataTypes.DATE },
  endDate:        { type: DataTypes.DATE },
  flutterwaveRef: { type: DataTypes.STRING },
  projectStage:   { type: DataTypes.ENUM('strategy','design','build','review','live'), defaultValue: 'strategy' },
  projectNote:    { type: DataTypes.TEXT },
});

const PaymentTransaction = sequelize.define('PaymentTransaction', {
  id:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId:           { type: DataTypes.UUID, allowNull: false },
  txRef:            { type: DataTypes.STRING, allowNull: false, unique: true },
  plan:             { type: DataTypes.ENUM('essential','growth','360','custom','course'), allowNull: false },
  status:           { type: DataTypes.ENUM('pending','successful','failed'), defaultValue: 'pending' },
  amount:           { type: DataTypes.DECIMAL(10,2), allowNull: false },
  currency:         { type: DataTypes.STRING, defaultValue: 'NGN' },
  // Course delivery details
  deliveryMethod:   { type: DataTypes.STRING },   // 'email' | 'whatsapp'
  deliveryContact:  { type: DataTypes.STRING },   // email address or WhatsApp number
  description:      { type: DataTypes.TEXT },     // custom plan description
});

const Lead = sequelize.define('Lead', {
  id:      { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name:    { type: DataTypes.STRING },
  email:   { type: DataTypes.STRING },
  phone:   { type: DataTypes.STRING },
  plan:    { type: DataTypes.STRING },
  message: { type: DataTypes.TEXT },
  status:  { type: DataTypes.ENUM('new','contacted','converted','lost'), defaultValue: 'new' },
});

const SupportRequest = sequelize.define('SupportRequest', {
  id:      { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId:  { type: DataTypes.UUID, allowNull: false },
  subject: { type: DataTypes.STRING, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  status:  { type: DataTypes.ENUM('open','in_review','resolved'), defaultValue: 'open' },
  reply:   { type: DataTypes.TEXT },
});

User.hasMany(Subscription);
Subscription.belongsTo(User);
User.hasMany(SupportRequest, { foreignKey: 'userId' });
SupportRequest.belongsTo(User, { foreignKey: 'userId' });

// ─── EMAIL TRANSPORT ──────────────────────────────────────────
//
// Uses Gmail with an App Password (NOT your regular Gmail password).
// Setup: Gmail settings → Security → 2-Step Verification (on) →
//        App Passwords → generate → copy into GMAIL_APP_PASSWORD env var.
//
const createTransport = () => nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,        // e.g. summitweb33@gmail.com
    pass: process.env.GMAIL_APP_PASSWORD, // 16-character App Password from Google
  },
});

// ─── WHATSAPP VIA TWILIO ──────────────────────────────────────
//
// Uses Twilio's WhatsApp API.
// Setup: twilio.com → Console → Messaging → WhatsApp Senders.
// Required env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
// TWILIO_WHATSAPP_FROM format: 'whatsapp:+1234567890' (your Twilio number)
//
const sendWhatsApp = async (to, message) => {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_FROM;

  if (!sid || !token || !from) {
    console.log('[WhatsApp] Twilio not configured — skipping WhatsApp send.');
    return false;
  }

  // Ensure 'to' has the whatsapp: prefix and international format
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    await axios.post(
      url,
      new URLSearchParams({ From: from, To: toFormatted, Body: message }).toString(),
      {
        auth: { username: sid, password: token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );
    return true;
  } catch (err) {
    console.error('[WhatsApp] Send failed:', err.response?.data || err.message);
    return false;
  }
};

// ─── COURSE PDF PATH ──────────────────────────────────────────
//
// Place your PDF at this path on the server, OR set COURSE_PDF_URL
// to a publicly accessible download link (Google Drive, Cloudinary, etc.)
//
const COURSE_PDF_PATH = process.env.COURSE_PDF_PATH || path.join(__dirname, 'course.pdf');
const COURSE_PDF_URL  = process.env.COURSE_PDF_URL  || null;

// ─── NOTIFICATION HELPERS ─────────────────────────────────────

// Sends the course PDF to the customer (email attachment or WhatsApp link)
const deliverCoursePDF = async ({ deliveryMethod, deliveryContact, customerName }) => {
  const transport = createTransport();

  if (deliveryMethod === 'email') {
    // Build attachments array — use file if it exists, otherwise skip attachment
    const attachments = [];
    if (fs.existsSync(COURSE_PDF_PATH)) {
      attachments.push({
        filename: 'Summit_Web_Digital_Marketing_Masterclass.pdf',
        path: COURSE_PDF_PATH,
      });
    } else if (COURSE_PDF_URL) {
      // Include download link in body instead
    }

    const downloadSection = COURSE_PDF_URL && !fs.existsSync(COURSE_PDF_PATH)
      ? `<p style="margin:16px 0;"><a href="${COURSE_PDF_URL}" style="background:#5170FF;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Download Your Course PDF</a></p>`
      : '';

    await transport.sendMail({
      from:    `"Summit Web" <${process.env.GMAIL_USER}>`,
      to:      deliveryContact,
      subject: 'Your Digital Marketing Masterclass — Summit Web',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
          <div style="background:#5170FF;padding:28px 32px;border-radius:8px 8px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:24px;">Summit Web</h1>
            <p style="color:#C0D0FF;margin:6px 0 0;font-size:14px;">Nigeria's Headache-Free Digital Partner</p>
          </div>
          <div style="padding:32px;background:#fff;border:1px solid #eee;border-top:none;">
            <h2 style="color:#111;font-size:20px;margin-top:0;">
              Your course is here, ${customerName || 'there'}!
            </h2>
            <p style="color:#444;line-height:1.7;">
              Thank you for purchasing the <strong>Digital Marketing Masterclass</strong>.
              Your PDF is attached to this email — save it somewhere safe so you can
              refer back to it anytime.
            </p>
            ${downloadSection}
            <p style="color:#444;line-height:1.7;">
              Inside you will find everything you need to attract customers online,
              keep them coming back, and grow what they spend with you — step by step,
              no jargon, no fluff.
            </p>
            <p style="color:#444;line-height:1.7;">
              Whenever you are ready to take the next step and have Summit Web
              execute your digital marketing for you, we are one WhatsApp message away.
            </p>
            <div style="margin:28px 0;padding:20px;background:#EEF0FF;border-radius:8px;border-left:4px solid #5170FF;">
              <p style="margin:0 0 8px;font-weight:bold;color:#3451DB;">Get in Touch</p>
              <p style="margin:4px 0;color:#444;font-size:14px;">WhatsApp: +234 904 874 7185</p>
              <p style="margin:4px 0;color:#444;font-size:14px;">Email: summitweb33@gmail.com</p>
              <p style="margin:4px 0;color:#444;font-size:14px;">Website: summitweb.com.ng</p>
            </div>
            <p style="color:#444;line-height:1.7;">
              Let's take your business to the summit together.<br/>
              <strong>Patrick K. Haruna</strong><br/>
              <span style="color:#777;font-size:13px;">Founder and CEO, Summit Web</span>
            </p>
          </div>
          <div style="padding:16px 32px;background:#F7F8FC;border-radius:0 0 8px 8px;border:1px solid #eee;border-top:none;">
            <p style="color:#999;font-size:12px;margin:0;text-align:center;">
              © 2026 Summit Web. Jos, Plateau State, Nigeria.<br/>
              This email was sent because you purchased a course from summitweb.com.ng
            </p>
          </div>
        </div>`,
      attachments,
    });

    console.log(`[Course] PDF emailed to ${deliveryContact}`);
    return true;
  }

  if (deliveryMethod === 'whatsapp') {
    const message = COURSE_PDF_URL
      ? `Hello ${customerName || 'there'}! Thank you for purchasing the Summit Web Digital Marketing Masterclass. Here is your course download link:\n\n${COURSE_PDF_URL}\n\nSave it — this is your personal copy. Anytime you need help executing your digital marketing, WhatsApp us. We are here.\n\nPatrick K. Haruna\nFounder, Summit Web`
      : `Hello ${customerName || 'there'}! Thank you for purchasing the Summit Web Digital Marketing Masterclass. Your course PDF will be sent to you within the next 30 minutes. If you do not receive it, please WhatsApp us directly at +234 904 874 7185.\n\nPatrick K. Haruna\nFounder, Summit Web`;

    const sent = await sendWhatsApp(deliveryContact, message);

    // If WhatsApp not configured, fall back to emailing Patrick to send manually
    if (!sent) {
      await transport.sendMail({
        from:    `"Summit Web System" <${process.env.GMAIL_USER}>`,
        to:      process.env.GMAIL_USER,
        subject: `[ACTION NEEDED] Send course PDF to WhatsApp: ${deliveryContact}`,
        html: `
          <p>A customer bought the course and chose WhatsApp delivery, but Twilio is not configured.</p>
          <p><strong>Send the PDF manually to:</strong> ${deliveryContact}</p>
          <p><strong>Customer name:</strong> ${customerName || 'Not available'}</p>
          <p>Send via WhatsApp: <a href="https://wa.me/${deliveryContact.replace(/\D/g,'')}">Click here to open chat</a></p>`,
      });
      console.log(`[Course] WhatsApp not configured — emailed Patrick to send manually to ${deliveryContact}`);
    }

    return true;
  }

  return false;
};

// Notifies Patrick instantly when a new lead submits the contact form
const notifyNewLead = async ({ name, email, phone, plan, message }) => {
  const planLabels = {
    essential: 'Summit Essential (N14,950/mo)',
    growth:    'Summit Growth (N87,350/mo)',
    '360':     'Summit 360 (N179,120/mo)',
    unsure:    'Not sure yet',
  };

  // 1. Email notification to Patrick
  try {
    const transport = createTransport();
    await transport.sendMail({
      from:    `"Summit Web Leads" <${process.env.GMAIL_USER}>`,
      to:      process.env.GMAIL_USER,
      subject: `New Lead: ${name} is interested in ${planLabels[plan] || plan || 'a plan'}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
          <div style="background:#5170FF;padding:20px 28px;border-radius:8px 8px 0 0;">
            <h2 style="color:#fff;margin:0;font-size:20px;">New Lead — Summit Web</h2>
          </div>
          <div style="padding:28px;background:#fff;border:1px solid #eee;border-top:none;">
            <table style="width:100%;border-collapse:collapse;">
              <tr style="background:#EEF0FF;">
                <td style="padding:10px 14px;font-weight:bold;color:#3451DB;width:120px;">Name</td>
                <td style="padding:10px 14px;color:#111;">${name || 'Not provided'}</td>
              </tr>
              <tr>
                <td style="padding:10px 14px;font-weight:bold;color:#3451DB;">Email</td>
                <td style="padding:10px 14px;"><a href="mailto:${email}">${email || 'Not provided'}</a></td>
              </tr>
              <tr style="background:#EEF0FF;">
                <td style="padding:10px 14px;font-weight:bold;color:#3451DB;">Phone</td>
                <td style="padding:10px 14px;"><a href="tel:${phone}">${phone || 'Not provided'}</a></td>
              </tr>
              <tr>
                <td style="padding:10px 14px;font-weight:bold;color:#3451DB;">Plan</td>
                <td style="padding:10px 14px;">${planLabels[plan] || plan || 'Not specified'}</td>
              </tr>
              <tr style="background:#EEF0FF;">
                <td style="padding:10px 14px;font-weight:bold;color:#3451DB;">Message</td>
                <td style="padding:10px 14px;">${message || 'No message'}</td>
              </tr>
            </table>
            <div style="margin-top:24px;display:flex;gap:12px;">
              <a href="https://wa.me/${(phone||'').replace(/\D/g,'')}"
                 style="background:#25D366;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block;margin-right:10px;">
                WhatsApp ${name}
              </a>
              <a href="mailto:${email}"
                 style="background:#5170FF;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block;">
                Reply by Email
              </a>
            </div>
          </div>
          <div style="padding:12px 28px;background:#F7F8FC;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
            <p style="color:#999;font-size:12px;margin:0;">Summit Web Lead Alert — summitweb.com.ng</p>
          </div>
        </div>`,
    });
    console.log(`[Lead] Email notification sent for ${name}`);
  } catch (err) {
    console.error('[Lead] Email notification failed:', err.message);
  }

  // 2. WhatsApp notification to Patrick
  const waMsg = `NEW LEAD - Summit Web\n\nName: ${name}\nPhone: ${phone || 'Not given'}\nEmail: ${email || 'Not given'}\nPlan: ${planLabels[plan] || plan || 'Not specified'}\nMessage: ${message || 'None'}\n\nReply quickly - leads convert fastest within 5 minutes!`;

  await sendWhatsApp(process.env.OWNER_WHATSAPP || '+2349048747185', waMsg);
};

// Notifies Patrick when a plan subscription is activated
const notifyNewSubscription = async ({ customerName, customerEmail, plan, amount }) => {
  const transport = createTransport();
  const planLabels = { essential:'Summit Essential', growth:'Summit Growth', '360':'Summit 360', custom:'Custom Plan', course:'Course' };

  try {
    await transport.sendMail({
      from:    `"Summit Web Payments" <${process.env.GMAIL_USER}>`,
      to:      process.env.GMAIL_USER,
      subject: `Payment Confirmed: ${customerName} just subscribed to ${planLabels[plan] || plan}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">
          <div style="background:#5170FF;padding:20px 28px;border-radius:8px 8px 0 0;">
            <h2 style="color:#fff;margin:0;">New Subscriber</h2>
          </div>
          <div style="padding:24px;background:#fff;border:1px solid #eee;border-top:none;">
            <p style="font-size:16px;color:#111;"><strong>${customerName}</strong> just paid for <strong>${planLabels[plan] || plan}</strong>.</p>
            <p style="font-size:14px;color:#555;">Email: <a href="mailto:${customerEmail}">${customerEmail}</a></p>
            <p style="font-size:22px;font-weight:bold;color:#5170FF;">Amount: N${parseFloat(amount).toLocaleString()}</p>
            <p style="font-size:13px;color:#777;">Log in to your admin dashboard to view and update their project status.</p>
          </div>
        </div>`,
    });
  } catch (err) {
    console.error('[Sub] Notification failed:', err.message);
  }

  await sendWhatsApp(
    process.env.OWNER_WHATSAPP || '+2349048747185',
    `PAYMENT RECEIVED\n\n${customerName} just paid for ${planLabels[plan] || plan}.\nAmount: N${parseFloat(amount).toLocaleString()}\nEmail: ${customerEmail}\n\nLog into your admin dashboard to assign their project stage.`
  );
};

// ─── MIDDLEWARE ───────────────────────────────────────────────

const protect = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer'))
    return res.status(401).json({ success: false, message: 'Not authorized' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    req.user = await User.findByPk(decoded.id);
    if (!req.user) return res.status(401).json({ success: false, message: 'User not found' });
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

const adminProtect = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_SECRET)
    return res.status(401).json({ success: false, message: 'Admin access denied' });
  next();
};

// ─── AUTH ROUTES ──────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'All fields are required' });
    const existing = await User.findOne({ where: { email } });
    if (existing)
      return res.status(400).json({ success: false, message: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const user   = await User.create({ name, email, password: hashed });
    const token  = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/auth/profile', protect, async (req, res) => {
  try {
    const subscription = await Subscription.findOne({
      where: { UserId: req.user.id },
      order: [['createdAt', 'DESC']],
    });
    const payments = await PaymentTransaction.findAll({
      where: { userId: req.user.id, status: 'successful' },
      order: [['createdAt', 'DESC']],
      limit: 12,
    });
    const supportRequests = await SupportRequest.findAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']],
      limit: 10,
    });
    res.json({
      success: true,
      user: { id: req.user.id, name: req.user.name, email: req.user.email },
      subscription: subscription || null,
      payments,
      supportRequests,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── SUBSCRIPTION ROUTES ──────────────────────────────────────

app.post('/api/subscription/initiate', protect, async (req, res) => {
  const { plan, amount: bodyAmount, description, deliveryMethod, deliveryContact } = req.body;

  const fixedAmounts = { essential: 14950, growth: 87350, '360': 179120, course: 2050 };
  let amount = fixedAmounts[plan];
  if (!amount && bodyAmount) amount = parseFloat(bodyAmount);
  if (!amount || amount <= 0)
    return res.status(400).json({ success: false, message: 'Invalid plan or amount' });

  const txRef = `SW-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  await PaymentTransaction.create({
    userId: req.user.id,
    txRef, plan, amount,
    currency: 'NGN',
    deliveryMethod:  deliveryMethod  || null,
    deliveryContact: deliveryContact || null,
    description:     description     || null,
  });

  try {
    const planLabels = { essential:'Essential Plan', growth:'Growth Plan', '360':'Summit 360', custom:'Custom Plan', course:'Digital Marketing Course' };
    const response = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      {
        tx_ref:       txRef,
        amount,
        currency:     'NGN',
        redirect_url: `${process.env.FRONTEND_URL}?page=dashboard`,
        customer:     { email: req.user.email, name: req.user.name },
        customizations: {
          title: `Summit Web — ${planLabels[plan] || plan}`,
          logo:  `${process.env.FRONTEND_URL}/logo.png`,
        },
      },
      { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
    );
    res.json({ success: true, paymentUrl: response.data.data.link });
  } catch {
    res.status(500).json({ success: false, message: 'Payment initiation failed. Please try again.' });
  }
});

// ─── FLUTTERWAVE WEBHOOK ──────────────────────────────────────

app.post('/api/webhooks/flutterwave', async (req, res) => {
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== process.env.FLUTTERWAVE_WEBHOOK_SECRET)
    return res.status(401).send('Unauthorized');

  const event = req.body;

  if (event.event === 'charge.completed' && event.data.status === 'successful') {
    const txRef       = event.data.tx_ref;
    const transaction = await PaymentTransaction.findOne({ where: { txRef } });

    if (transaction && transaction.status === 'pending') {
      // Mark payment successful
      transaction.status = 'successful';
      await transaction.save();

      // Find user for notifications
      const user = await User.findByPk(transaction.userId);

      if (transaction.plan === 'course') {
        // ── COURSE: deliver PDF, do NOT create a subscription ──
        if (transaction.deliveryMethod && transaction.deliveryContact) {
          await deliverCoursePDF({
            deliveryMethod:  transaction.deliveryMethod,
            deliveryContact: transaction.deliveryContact,
            customerName:    user ? user.name : null,
          });
        }
        // Also notify Patrick
        if (user) {
          await notifyNewSubscription({
            customerName:  user.name,
            customerEmail: user.email,
            plan:          'course',
            amount:        transaction.amount,
          });
        }

      } else {
        // ── SUBSCRIPTION PLAN: activate subscription ──
        const existing = await Subscription.findOne({
          where: { UserId: transaction.userId, status: 'active' },
        });
        if (existing) { existing.status = 'inactive'; await existing.save(); }

        await Subscription.create({
          plan:           transaction.plan,
          status:         'active',
          startDate:      new Date(),
          UserId:         transaction.userId,
          flutterwaveRef: transaction.txRef,
          projectStage:   'strategy',
        });

        // Notify Patrick of new subscriber
        if (user) {
          await notifyNewSubscription({
            customerName:  user.name,
            customerEmail: user.email,
            plan:          transaction.plan,
            amount:        transaction.amount,
          });
        }
      }
    }
  }

  res.sendStatus(200);
});

app.post('/api/subscription/cancel', protect, async (req, res) => {
  try {
    const sub = await Subscription.findOne({ where: { UserId: req.user.id, status: 'active' } });
    if (!sub) return res.status(404).json({ success: false, message: 'No active subscription found' });
    sub.status = 'cancelled';
    await sub.save();
    res.json({ success: true, message: 'Subscription cancelled successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── SUPPORT ROUTES ───────────────────────────────────────────

app.post('/api/support', protect, async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!subject || !message)
      return res.status(400).json({ success: false, message: 'Subject and message are required' });
    const request = await SupportRequest.create({ userId: req.user.id, subject, message });

    // Notify Patrick about new support request
    const transport = createTransport();
    transport.sendMail({
      from:    `"Summit Web Support" <${process.env.GMAIL_USER}>`,
      to:      process.env.GMAIL_USER,
      subject: `Support Request: ${subject} — from ${req.user.name}`,
      html: `
        <p><strong>${req.user.name}</strong> submitted a support request.</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <p><strong>Message:</strong> ${message}</p>
        <p><strong>Email:</strong> <a href="mailto:${req.user.email}">${req.user.email}</a></p>
        <p><a href="${process.env.FRONTEND_URL}/?admin=1">Open Admin Dashboard to Reply</a></p>`,
    }).catch(err => console.error('[Support] Notify failed:', err.message));

    res.status(201).json({ success: true, request });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── CONTACT / LEAD ROUTE ─────────────────────────────────────

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, plan, message } = req.body;
    await Lead.create({ name, email, phone, plan, message });

    // Fire-and-forget: notify Patrick via email + WhatsApp
    notifyNewLead({ name, email, phone, plan, message })
      .catch(err => console.error('[Lead] Notification error:', err.message));

    res.json({ success: true, message: 'We will contact you within 24 hours' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_SECRET)
    return res.status(401).json({ success: false, message: 'Wrong admin password' });
  res.json({ success: true, token: process.env.ADMIN_SECRET });
});

app.get('/api/admin/dashboard', adminProtect, async (req, res) => {
  try {
    const now          = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthPayments = await PaymentTransaction.findAll({ where: { status: 'successful', createdAt: { [Op.gte]: startOfMonth } } });
    const monthlyRevenue = monthPayments.reduce((s, p) => s + parseFloat(p.amount), 0);
    const allPayments    = await PaymentTransaction.findAll({ where: { status: 'successful' } });
    const totalRevenue   = allPayments.reduce((s, p) => s + parseFloat(p.amount), 0);
    const activeEssential = await Subscription.count({ where: { status: 'active', plan: 'essential' } });
    const activeGrowth    = await Subscription.count({ where: { status: 'active', plan: 'growth' } });
    const active360       = await Subscription.count({ where: { status: 'active', plan: '360' } });
    const totalActive     = activeEssential + activeGrowth + active360;
    const newThisMonth    = await Subscription.count({ where: { status: 'active', createdAt: { [Op.gte]: startOfMonth } } });
    const churnThisMonth  = await Subscription.count({ where: { status: 'cancelled', updatedAt: { [Op.gte]: startOfMonth } } });
    const totalLeads      = await Lead.count();
    const newLeads        = await Lead.count({ where: { status: 'new' } });
    const openSupport     = await SupportRequest.count({ where: { status: { [Op.ne]: 'resolved' } } });
    res.json({
      success: true,
      stats: { monthlyRevenue, totalRevenue, activeClients: totalActive, newThisMonth, churnThisMonth,
               byPlan: { essential: activeEssential, growth: activeGrowth, '360': active360 },
               totalLeads, newLeads, openSupport },
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/clients', adminProtect, async (req, res) => {
  try {
    const subscriptions = await Subscription.findAll({
      include: [{ model: User, attributes: ['name','email'] }],
      order:   [['createdAt','DESC']],
    });
    res.json({ success: true, clients: subscriptions });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/leads', adminProtect, async (req, res) => {
  try {
    const leads = await Lead.findAll({ order: [['createdAt','DESC']] });
    res.json({ success: true, leads });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.patch('/api/admin/leads/:id', adminProtect, async (req, res) => {
  try {
    const lead = await Lead.findByPk(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    lead.status = req.body.status;
    await lead.save();
    res.json({ success: true, lead });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/support', adminProtect, async (req, res) => {
  try {
    const requests = await SupportRequest.findAll({
      include: [{ model: User, attributes: ['name','email'] }],
      order:   [['createdAt','DESC']],
    });
    res.json({ success: true, requests });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.patch('/api/admin/support/:id', adminProtect, async (req, res) => {
  try {
    const request = await SupportRequest.findByPk(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
    if (req.body.reply)  request.reply  = req.body.reply;
    if (req.body.status) request.status = req.body.status;
    await request.save();
    res.json({ success: true, request });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.patch('/api/admin/subscription/:id/stage', adminProtect, async (req, res) => {
  try {
    const sub = await Subscription.findByPk(req.params.id);
    if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });
    if (req.body.projectStage) sub.projectStage = req.body.projectStage;
    if (req.body.projectNote)  sub.projectNote  = req.body.projectNote;
    await sub.save();
    res.json({ success: true, subscription: sub });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// ═══════════════════════════════════════════════════════════════
// EMAIL FUNNEL SYSTEM
// Runs every hour. Checks which emails are due and sends them.
// ═══════════════════════════════════════════════════════════════

// ─── EmailLog model — tracks which emails have been sent ───────
const EmailLog = sequelize.define('EmailLog', {
  id:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId:     { type: DataTypes.UUID, allowNull: false },
  sequence:   { type: DataTypes.STRING, allowNull: false }, // 'welcome' | 'post_purchase' | 'winback' | 'course'
  step:       { type: DataTypes.INTEGER, allowNull: false }, // 1,2,3,4,5
  sentAt:     { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
});

// Helper: has this email already been sent?
const alreadySent = async (userId, sequence, step) => {
  const log = await EmailLog.findOne({ where: { userId, sequence, step } });
  return !!log;
};

// Helper: record that an email was sent
const markSent = async (userId, sequence, step) => {
  await EmailLog.create({ userId, sequence, step });
};

// Helper: days since a date
const daysSince = (date) => {
  return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
};

// ─── EMAIL TEMPLATES ──────────────────────────────────────────

const emailWrapper = (content) => `
<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111;line-height:1.7;">
  <div style="background:#5170FF;padding:24px 32px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:22px;font-weight:bold;">Summit Web</h1>
    <p style="color:#C0D0FF;margin:4px 0 0;font-size:13px;">Nigeria's Headache-Free Digital Partner</p>
  </div>
  <div style="padding:32px;background:#fff;border:1px solid #e8e8ee;border-top:none;">
    ${content}
  </div>
  <div style="padding:16px 32px;background:#F7F8FC;border:1px solid #e8e8ee;border-top:none;border-radius:0 0 8px 8px;">
    <p style="color:#999;font-size:12px;margin:0;text-align:center;">
      Summit Web &bull; Jos, Plateau State, Nigeria<br/>
      <a href="https://wa.me/2349048747185" style="color:#5170FF;">WhatsApp</a> &bull;
      <a href="mailto:summitweb33@gmail.com" style="color:#5170FF;">Email</a> &bull;
      <a href="https://summitweb.com.ng" style="color:#5170FF;">Website</a>
    </p>
  </div>
</div>`;

const planLabels = {
  essential: 'Summit Essential',
  growth:    'Summit Growth',
  '360':     'Summit 360',
  custom:    'Custom Plan',
  course:    'Digital Marketing Course',
};

const planBenefits = {
  essential: 'branding consultations, AI setup, and priority support',
  growth:    'branding, AI setup, a mini website, and social media setup',
  '360':     'everything — SEO, advanced website, social media management, AI setup, and unlimited branding consultations',
};

// Welcome series — triggered after a new subscription is activated
const welcomeEmails = {
  1: (name, plan) => ({
    subject: `Welcome to Summit Web, ${name}! Your journey starts now.`,
    html: emailWrapper(`
      <h2 style="color:#111;font-size:20px;margin-top:0;">You made the right call, ${name}.</h2>
      <p>Welcome to the <strong>${planLabels[plan] || plan}</strong> plan. You are now part of a growing community of Nigerian businesses that are taking their digital presence seriously.</p>
      <p>Here is what happens next:</p>
      <ol style="color:#444;padding-left:20px;">
        <li style="margin-bottom:8px;">Our team reviews your account and begins your project setup within 24 hours.</li>
        <li style="margin-bottom:8px;">You will receive a WhatsApp message from us introducing your dedicated account handler.</li>
        <li style="margin-bottom:8px;">We schedule your first branding consultation at a time that works for you.</li>
      </ol>
      <p>While you wait, log into your dashboard to track your project progress in real time.</p>
      <div style="margin:24px 0;">
        <a href="${process.env.FRONTEND_URL}?page=dashboard"
           style="background:#5170FF;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">
          View My Dashboard
        </a>
      </div>
      <p style="color:#555;">Any questions right now? WhatsApp us directly at <strong>+234 904 874 7185</strong>. We respond in under a minute.</p>
      <p style="margin-top:28px;">To your success,<br/><strong>Patrick K. Haruna</strong><br/><span style="color:#777;font-size:13px;">Founder and CEO, Summit Web</span></p>`)
  }),

  2: (name, plan) => ({
    subject: `One thing most new clients miss (do not skip this, ${name})`,
    html: emailWrapper(`
      <h2 style="color:#111;font-size:20px;margin-top:0;">Quick tip before we go further.</h2>
      <p>Hi ${name}, we are already working on your ${planLabels[plan] || plan} setup. While we build, here is the one thing that separates businesses that grow fast from those that take forever to see results:</p>
      <div style="background:#EEF0FF;border-left:4px solid #5170FF;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0;">
        <p style="margin:0;font-weight:bold;color:#3451DB;font-size:15px;">"Know exactly who you are talking to before you say anything."</p>
      </div>
      <p>Before your first consultation with us, take 10 minutes to write down:</p>
      <ul style="color:#444;padding-left:20px;">
        <li style="margin-bottom:6px;">Who is your ideal customer? (Age, location, income, habits)</li>
        <li style="margin-bottom:6px;">What is their biggest problem that your product solves?</li>
        <li style="margin-bottom:6px;">Where do they spend time online?</li>
        <li style="margin-bottom:6px;">What objection stops them from buying immediately?</li>
      </ul>
      <p>Bring these answers to your consultation. It will make every decision we make together sharper and faster.</p>
      <p>We will be in touch within 24 hours to book your first session.<br/><br/>
      <strong>Patrick K. Haruna</strong><br/><span style="color:#777;font-size:13px;">Founder and CEO, Summit Web</span></p>`)
  }),

  3: (name, plan) => ({
    subject: `How Amara grew her Lagos brand by 150% in two months`,
    html: emailWrapper(`
      <h2 style="color:#111;font-size:20px;margin-top:0;">A story worth reading, ${name}.</h2>
      <p>Before I tell you about Amara, let me be clear: this is not a rare outcome. This is what happens when a business owner commits fully to the process.</p>
      <p>Amara runs a fashion brand in Lagos. When she came to Summit Web, she had great products, a decent Instagram page, and almost no online sales. She was frustrated. She had tried boosting posts, tried WhatsApp broadcasts, tried everything she saw influencers doing.</p>
      <p>We did four things with her:</p>
      <ol style="color:#444;padding-left:20px;">
        <li style="margin-bottom:8px;">Rebuilt her brand identity so it communicated quality and exclusivity instead of 'just another fashion page.'</li>
        <li style="margin-bottom:8px;">Set up a content strategy that educated and inspired her audience instead of just selling at them.</li>
        <li style="margin-bottom:8px;">Built a simple landing page that converted visitors into WhatsApp inquiries.</li>
        <li style="margin-bottom:8px;">Set up an AI tool that responded to DMs instantly, even at 2am.</li>
      </ol>
      <p>In two months, her online sales grew by 150%.</p>
      <p>You have the same tools available to you right now in your <strong>${planLabels[plan] || plan}</strong> plan. We are going to make this work for you too.</p>
      <p><strong>Patrick K. Haruna</strong><br/><span style="color:#777;font-size:13px;">Founder and CEO, Summit Web</span></p>`)
  }),

  4: (name, plan) => ({
    subject: `Your exclusive two-week gift from Summit Web`,
    html: emailWrapper(`
      <h2 style="color:#111;font-size:20px;margin-top:0;">Two weeks in. Here is a thank you.</h2>
      <p>Hi ${name}, you have been with Summit Web for two weeks now, and we genuinely appreciate your trust in us.</p>
      <p>As a thank you, here is something exclusively for you:</p>
      <div style="background:#5170FF;color:#fff;padding:20px 24px;border-radius:8px;text-align:center;margin:24px 0;">
        <p style="margin:0;font-size:18px;font-weight:bold;">20% off any additional service</p>
        <p style="margin:8px 0 0;font-size:14px;color:#C0D0FF;">Valid for the next 7 days. Existing clients only.</p>
        <p style="margin:12px 0 0;font-size:28px;font-weight:bold;letter-spacing:4px;">SUMMIT20</p>
      </div>
      <p>Whether you want to add more branded flyers, upgrade your plan, or get an additional consultation session, reply to this email or WhatsApp us and we will apply it immediately.</p>
      <p>This offer expires in 7 days and is only for you — it is not advertised anywhere.</p>
      <p><strong>Patrick K. Haruna</strong><br/><span style="color:#777;font-size:13px;">Founder and CEO, Summit Web</span></p>`)
  }),

  5: (name, plan) => ({
    subject: `One month with Summit Web — an honest question for you, ${name}`,
    html: emailWrapper(`
      <h2 style="color:#111;font-size:20px;margin-top:0;">A genuine question, ${name}.</h2>
      <p>You have been with us for about a month now. We have done a lot together, and I want to hear directly from you.</p>
      <p><strong>What has your experience been so far?</strong></p>
      <p>Specifically, I want to know:</p>
      <ul style="color:#444;padding-left:20px;">
        <li style="margin-bottom:6px;">What is the one thing we have done that has already made a difference for your business?</li>
        <li style="margin-bottom:6px;">What could we be doing better or faster?</li>
        <li style="margin-bottom:6px;">Is there a service you wish we offered that we do not yet?</li>
      </ul>
      <p>Just reply to this email. I read every single response personally.</p>
      <p>Your feedback makes Summit Web better for you and for every Nigerian business owner we serve after you.</p>
      <p>Thank you for being part of this.<br/><br/>
      <strong>Patrick K. Haruna</strong><br/><span style="color:#777;font-size:13px;">Founder and CEO, Summit Web</span></p>`)
  }),
};

// Win-back sequence — triggered after 45 days of inactivity
const winbackEmails = {
  1: (name) => ({
    subject: `${name}, we have been building something. Come see.`,
    html: emailWrapper(`
      <h2 style="color:#111;font-size:20px;margin-top:0;">It has been a while, ${name}.</h2>
      <p>We noticed you have not been active with Summit Web recently, and we want to change that.</p>
      <p>While you were away, we have been busy. Here is what is new at Summit Web:</p>
      <ul style="color:#444;padding-left:20px;">
        <li style="margin-bottom:8px;">New AI tools that automate customer replies and lead generation</li>
        <li style="margin-bottom:8px;">Updated Social Media Management packages with proven results</li>
        <li style="margin-bottom:8px;">A brand new Digital Marketing Masterclass course (available now)</li>
        <li style="margin-bottom:8px;">Improved website packages with faster delivery timelines</li>
      </ul>
      <p>We would love to have you back. Your business deserves a strong digital presence, and we are the team to build it.</p>
      <div style="margin:24px 0;">
        <a href="${process.env.FRONTEND_URL}?page=pricing"
           style="background:#5170FF;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">
          See What We Can Do For You
        </a>
      </div>
      <p><strong>Patrick K. Haruna</strong><br/><span style="color:#777;font-size:13px;">Founder and CEO, Summit Web</span></p>`)
  }),

  2: (name) => ({
    subject: `Your 30% returning client discount expires in 48 hours`,
    html: emailWrapper(`
      <h2 style="color:#111;font-size:20px;margin-top:0;">This offer is just for you, ${name}.</h2>
      <p>Because you have worked with Summit Web before, we are offering you something we do not advertise publicly:</p>
      <div style="background:#5170FF;color:#fff;padding:20px 24px;border-radius:8px;text-align:center;margin:24px 0;">
        <p style="margin:0;font-size:18px;font-weight:bold;">30% off your first month back</p>
        <p style="margin:8px 0 0;font-size:14px;color:#C0D0FF;">For returning clients only. Expires in 48 hours.</p>
        <p style="margin:12px 0 0;font-size:28px;font-weight:bold;letter-spacing:4px;">COMEBACK30</p>
      </div>
      <p>Simply WhatsApp us at <strong>+234 904 874 7185</strong> or reply to this email with the code and we will apply it to your next subscription.</p>
      <p>This code expires in 48 hours and cannot be extended.</p>
      <p><strong>Patrick K. Haruna</strong><br/><span style="color:#777;font-size:13px;">Founder and CEO, Summit Web</span></p>`)
  }),

  3: (name) => ({
    subject: `Final reminder — your discount closes tonight, ${name}`,
    html: emailWrapper(`
      <h2 style="color:#111;font-size:20px;margin-top:0;">Last chance, ${name}.</h2>
      <p>Your exclusive <strong>30% returning client discount</strong> closes tonight at midnight.</p>
      <p>After tonight, this offer will no longer be available and we cannot make exceptions.</p>
      <p>If you are ready to get your business growing online again, now is the moment.</p>
      <div style="margin:24px 0;">
        <a href="${process.env.FRONTEND_URL}?page=pricing"
           style="background:#5170FF;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;margin-right:12px;">
          Claim My 30% Discount
        </a>
        <a href="https://wa.me/2349048747185"
           style="background:#25D366;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">
          WhatsApp Us Now
        </a>
      </div>
      <p>Use code <strong>COMEBACK30</strong> when you reach out.</p>
      <p><strong>Patrick K. Haruna</strong><br/><span style="color:#777;font-size:13px;">Founder and CEO, Summit Web</span></p>`)
  }),
};

// ─── FUNNEL RUNNER — checks every hour ────────────────────────
const runEmailFunnels = async () => {
  try {
    const transport = createTransport();
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;

    const sendEmail = async (to, subject, html) => {
      await transport.sendMail({
        from: `"Patrick at Summit Web" <${process.env.GMAIL_USER}>`,
        to, subject, html,
      });
    };

    // ── WELCOME SEQUENCE: days 0, 2, 4, 14, 30 after subscription start ──
    const schedules = [0, 2, 4, 14, 30];
    const activeSubs = await Subscription.findAll({
      where: { status: 'active', plan: { [Op.notIn]: ['course'] } },
      include: [{ model: User }],
    });

    for (const sub of activeSubs) {
      const user = sub.User;
      if (!user || !user.email || !sub.startDate) continue;
      const days = daysSince(sub.startDate);

      for (let step = 1; step <= 5; step++) {
        const triggerDay = schedules[step - 1];
        if (days >= triggerDay && !(await alreadySent(user.id, 'welcome', step))) {
          const emailFn = welcomeEmails[step];
          if (!emailFn) continue;
          const { subject, html } = emailFn(user.name, sub.plan);
          await sendEmail(user.email, subject, html);
          await markSent(user.id, 'welcome', step);
          console.log(`[Funnel] Welcome step ${step} sent to ${user.email}`);
        }
      }
    }

    // ── WIN-BACK SEQUENCE: days 0, 3, 6 after going inactive ──
    const winbackSchedules = [0, 3, 6];
    const inactiveUsers = await User.findAll({
      include: [{
        model: Subscription,
        where: {
          status: { [Op.in]: ['cancelled', 'inactive'] },
          updatedAt: { [Op.lte]: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) },
        },
        required: true,
      }],
    });

    for (const user of inactiveUsers) {
      if (!user.email) continue;
      const sub = user.Subscriptions[0];
      if (!sub) continue;
      const daysSinceInactive = daysSince(sub.updatedAt);

      for (let step = 1; step <= 3; step++) {
        const triggerDay = winbackSchedules[step - 1];
        if (daysSinceInactive >= triggerDay + 45
            && !(await alreadySent(user.id, 'winback', step))) {
          const emailFn = winbackEmails[step];
          if (!emailFn) continue;
          const { subject, html } = emailFn(user.name);
          await sendEmail(user.email, subject, html);
          await markSent(user.id, 'winback', step);
          console.log(`[Funnel] Win-back step ${step} sent to ${user.email}`);
        }
      }
    }

  } catch (err) {
    console.error('[Funnel] Runner error:', err.message);
  }
};

// ─── START ────────────────────────────────────────────────────

sequelize.sync({ alter: true }).then(() => {
  app.listen(process.env.PORT || 5000, () => {
    console.log('Summit Web server running');

    // Run email funnels immediately on boot, then every hour
    runEmailFunnels();
    setInterval(runEmailFunnels, 60 * 60 * 1000);
    console.log('[Funnel] Email funnel scheduler started — runs every hour');
  });
});
