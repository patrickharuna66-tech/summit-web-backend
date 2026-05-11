const express = require('express');
const cors = require('cors');
const { Sequelize, DataTypes, Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    "https://summit-web-frontend.onrender.com",
    "http://localhost:3000",
    "http://localhost:5500",
  ],
  credentials: true,
}));
app.use(express.json());

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
});

// ─── MODELS ───────────────────────────────────────────

const User = sequelize.define('User', {
  id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name:     { type: DataTypes.STRING, allowNull: false },
  email:    { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
});

const Subscription = sequelize.define('Subscription', {
  id:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  plan:            { type: DataTypes.ENUM('essential', 'growth', '360'), allowNull: false },
  status:          { type: DataTypes.ENUM('active', 'inactive', 'cancelled'), defaultValue: 'inactive' },
  startDate:       { type: DataTypes.DATE },
  endDate:         { type: DataTypes.DATE },
  flutterwaveRef:  { type: DataTypes.STRING },
  // Project tracker stage: strategy > design > build > review > live
  projectStage:    { type: DataTypes.ENUM('strategy','design','build','review','live'), defaultValue: 'strategy' },
  projectNote:     { type: DataTypes.TEXT },
});

const PaymentTransaction = sequelize.define('PaymentTransaction', {
  id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId:   { type: DataTypes.UUID, allowNull: false },
  txRef:    { type: DataTypes.STRING, allowNull: false, unique: true },
  plan:     { type: DataTypes.ENUM('essential', 'growth', '360'), allowNull: false },
  status:   { type: DataTypes.ENUM('pending', 'successful', 'failed'), defaultValue: 'pending' },
  amount:   { type: DataTypes.DECIMAL(10,2), allowNull: false },
  currency: { type: DataTypes.STRING, defaultValue: 'NGN' },
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

// ─── MIDDLEWARE ───────────────────────────────────────

// Customer auth
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

// Admin auth — checks a separate ADMIN_SECRET env var
const adminProtect = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_SECRET)
    return res.status(401).json({ success: false, message: 'Admin access denied' });
  next();
};

// ─── CUSTOMER AUTH ROUTES ─────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'All fields are required' });
    const existing = await User.findOne({ where: { email } });
    if (existing)
      return res.status(400).json({ success: false, message: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashed });
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
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

// Customer profile — subscription + payments + support requests
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

// ─── SUBSCRIPTION ROUTES ──────────────────────────────

app.post('/api/subscription/initiate', protect, async (req, res) => {
  const { plan } = req.body;
  const amounts = { essential: 8000, growth: 18080, '360': 45080 };
  const amount = amounts[plan];
  if (!amount) return res.status(400).json({ success: false, message: 'Invalid plan' });

  const txRef = `SW-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  await PaymentTransaction.create({ userId: req.user.id, txRef, plan, amount, currency: 'NGN' });

  try {
    const response = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      {
        tx_ref: txRef,
        amount,
        currency: 'NGN',
        redirect_url: `${process.env.FRONTEND_URL}?page=dashboard`,
        customer: { email: req.user.email, name: req.user.name },
        customizations: { title: `Summit Web — ${plan} Plan`, logo: `${process.env.FRONTEND_URL}/logo.png` },
      },
      { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
    );
    res.json({ success: true, paymentUrl: response.data.data.link });
  } catch {
    res.status(500).json({ success: false, message: 'Payment initiation failed. Please try again.' });
  }
});

app.post('/api/webhooks/flutterwave', async (req, res) => {
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== process.env.FLUTTERWAVE_WEBHOOK_SECRET)
    return res.status(401).send('Unauthorized');

  const event = req.body;
  if (event.event === 'charge.completed' && event.data.status === 'successful') {
    const transaction = await PaymentTransaction.findOne({ where: { txRef: event.data.tx_ref } });
    if (transaction && transaction.status === 'pending') {
      transaction.status = 'successful';
      await transaction.save();
      // Deactivate any existing active subscription
      const existing = await Subscription.findOne({ where: { UserId: transaction.userId, status: 'active' } });
      if (existing) { existing.status = 'inactive'; await existing.save(); }
      // Create new active subscription
      await Subscription.create({
        plan: transaction.plan,
        status: 'active',
        startDate: new Date(),
        UserId: transaction.userId,
        flutterwaveRef: transaction.txRef,
        projectStage: 'strategy',
      });
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

// ─── SUPPORT REQUEST ROUTES ───────────────────────────

app.post('/api/support', protect, async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!subject || !message)
      return res.status(400).json({ success: false, message: 'Subject and message are required' });
    const request = await SupportRequest.create({ userId: req.user.id, subject, message });
    res.status(201).json({ success: true, request });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── CONTACT / LEAD ROUTE ────────────────────────────

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, plan, message } = req.body;
    await Lead.create({ name, email, phone, plan, message });
    res.json({ success: true, message: 'We will contact you within 24 hours' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN ROUTES ────────────────────────────────────

// Admin login — returns a session token based on ADMIN_SECRET
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_SECRET)
    return res.status(401).json({ success: false, message: 'Wrong admin password' });
  res.json({ success: true, token: process.env.ADMIN_SECRET });
});

// Admin: full dashboard stats
app.get('/api/admin/dashboard', adminProtect, async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Revenue this month
    const monthPayments = await PaymentTransaction.findAll({
      where: { status: 'successful', createdAt: { [Op.gte]: startOfMonth } },
    });
    const monthlyRevenue = monthPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    // All-time revenue
    const allPayments = await PaymentTransaction.findAll({ where: { status: 'successful' } });
    const totalRevenue = allPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    // Active subscribers per plan
    const activeEssential = await Subscription.count({ where: { status: 'active', plan: 'essential' } });
    const activeGrowth    = await Subscription.count({ where: { status: 'active', plan: 'growth' } });
    const active360       = await Subscription.count({ where: { status: 'active', plan: '360' } });
    const totalActive     = activeEssential + activeGrowth + active360;

    // New clients this month
    const newThisMonth = await Subscription.count({
      where: { status: 'active', createdAt: { [Op.gte]: startOfMonth } },
    });

    // Cancellations this month
    const churnThisMonth = await Subscription.count({
      where: { status: 'cancelled', updatedAt: { [Op.gte]: startOfMonth } },
    });

    // Leads
    const totalLeads = await Lead.count();
    const newLeads   = await Lead.count({ where: { status: 'new' } });

    // Open support requests
    const openSupport = await SupportRequest.count({ where: { status: { [Op.ne]: 'resolved' } } });

    res.json({
      success: true,
      stats: {
        monthlyRevenue, totalRevenue,
        activeClients: totalActive, newThisMonth, churnThisMonth,
        byPlan: { essential: activeEssential, growth: activeGrowth, '360': active360 },
        totalLeads, newLeads, openSupport,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: all clients
app.get('/api/admin/clients', adminProtect, async (req, res) => {
  try {
    const subscriptions = await Subscription.findAll({
      include: [{ model: User, attributes: ['name', 'email'] }],
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, clients: subscriptions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: all leads
app.get('/api/admin/leads', adminProtect, async (req, res) => {
  try {
    const leads = await Lead.findAll({ order: [['createdAt', 'DESC']] });
    res.json({ success: true, leads });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: update lead status
app.patch('/api/admin/leads/:id', adminProtect, async (req, res) => {
  try {
    const lead = await Lead.findByPk(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    lead.status = req.body.status;
    await lead.save();
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: all support requests
app.get('/api/admin/support', adminProtect, async (req, res) => {
  try {
    const requests = await SupportRequest.findAll({
      include: [{ model: User, attributes: ['name', 'email'] }],
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: reply to support request + update project stage
app.patch('/api/admin/support/:id', adminProtect, async (req, res) => {
  try {
    const request = await SupportRequest.findByPk(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
    if (req.body.reply)  request.reply  = req.body.reply;
    if (req.body.status) request.status = req.body.status;
    await request.save();
    res.json({ success: true, request });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: update project stage for a subscription
app.patch('/api/admin/subscription/:id/stage', adminProtect, async (req, res) => {
  try {
    const sub = await Subscription.findByPk(req.params.id);
    if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });
    if (req.body.projectStage) sub.projectStage = req.body.projectStage;
    if (req.body.projectNote)  sub.projectNote  = req.body.projectNote;
    await sub.save();
    res.json({ success: true, subscription: sub });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── START ────────────────────────────────────────────

sequelize.sync({ alter: true }).then(() => {
  app.listen(process.env.PORT || 5000, () => console.log('Summit Web server running'));
});
