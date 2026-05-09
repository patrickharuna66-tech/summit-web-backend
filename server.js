const express = require('express');
const cors = require('cors');
const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
});

const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
});

const Subscription = sequelize.define('Subscription', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  plan: { type: DataTypes.ENUM('essential', 'growth', '360'), allowNull: false },
  status: { type: DataTypes.ENUM('active', 'inactive', 'cancelled'), defaultValue: 'inactive' },
  startDate: { type: DataTypes.DATE },
  endDate: { type: DataTypes.DATE },
  flutterwaveRef: { type: DataTypes.STRING },
});

const PaymentTransaction = sequelize.define('PaymentTransaction', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false },
  txRef: { type: DataTypes.STRING, allowNull: false, unique: true },
  plan: { type: DataTypes.ENUM('essential', 'growth', '360'), allowNull: false },
  status: { type: DataTypes.ENUM('pending', 'successful', 'failed'), defaultValue: 'pending' },
  amount: { type: DataTypes.DECIMAL(10,2), allowNull: false },
  currency: { type: DataTypes.STRING, defaultValue: 'NGN' },
});

User.hasMany(Subscription);
Subscription.belongsTo(User);

const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return res.status(401).json({ success: false, message: 'Not authorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findByPk(decoded.id);
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

// Auth routes
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(400).json({ success: false, message: 'Email already registered' });
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const user = await User.create({ name, email, password: hashedPassword });
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
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/auth/profile', protect, async (req, res) => {
  const subscription = await Subscription.findOne({
    where: { UserId: req.user.id },
    order: [['createdAt', 'DESC']],
  });
  res.json({
    success: true,
    user: { id: req.user.id, name: req.user.name, email: req.user.email },
    subscription: subscription || null,
  });
});

app.post('/api/subscription/initiate', protect, async (req, res) => {
  const { plan } = req.body;
  const amounts = { essential: 8000, growth: 19080, '360': 45080 };
  const amount = amounts[plan];
  if (!amount) return res.status(400).json({ success: false, message: 'Invalid plan' });

  const txRef = `SW-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  await PaymentTransaction.create({
    userId: req.user.id,
    txRef,
    plan,
    amount,
    currency: 'NGN',
  });

  try {
    const response = await axios.post('https://api.flutterwave.com/v3/payments',
      {
        tx_ref: txRef,
        amount: amount,
        currency: 'NGN',
        redirect_url: `${process.env.FRONTEND_URL}?page=pricing`,
        customer: { email: req.user.email, name: req.user.name },
        customizations: { title: `Summit ${plan} Plan` },
      },
      {
        headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` },
      }
    );
    res.json({ success: true, paymentUrl: response.data.data.link });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Payment initiation failed' });
  }
});

app.post('/api/webhooks/flutterwave', async (req, res) => {
  const secretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET;
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== secretHash) {
    return res.status(401).send('Unauthorized');
  }

  const event = req.body;
  if (event.event === 'charge.completed' && event.data.status === 'successful') {
    const txRef = event.data.tx_ref;
    const transaction = await PaymentTransaction.findOne({ where: { txRef } });
    if (transaction && transaction.status === 'pending') {
      transaction.status = 'successful';
      await transaction.save();

      let sub = await Subscription.findOne({ where: { UserId: transaction.userId, status: 'active' } });
      if (sub) {
        sub.status = 'inactive';
        await sub.save();
      }
      await Subscription.create({
        plan: transaction.plan,
        status: 'active',
        startDate: new Date(),
        UserId: transaction.userId,
        flutterwaveRef: txRef,
      });
    }
  }
  res.sendStatus(200);
});

app.post('/api/subscription/cancel', protect, async (req, res) => {
  const sub = await Subscription.findOne({ where: { UserId: req.user.id, status: 'active' } });
  if (!sub) return res.status(404).json({ success: false, message: 'No active subscription' });
  sub.status = 'cancelled';
  await sub.save();
  res.json({ success: true, message: 'Subscription cancelled' });
});

app.post('/api/contact', (req, res) => {
  const { name, email, phone, plan, message } = req.body;
  console.log('New lead:', { name, email, phone, plan, message });
  res.json({ success: true, message: 'We will contact you within 24 hours' });
});

sequelize.sync().then(() => {
  app.listen(process.env.PORT || 5000, () => console.log('Server running'));
});
