const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const contactRoutes = require('./routes/contact');

const app = express();

// Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true
}));
app.use(express.json());

// Routes
app.use('/api/contact', contactRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date() });
});

// Error handling should also be here

module.exports = app;