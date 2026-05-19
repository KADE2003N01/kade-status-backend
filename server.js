import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import contactRoutes from './routes/contact.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// =====================
// MIDDLEWARE
// =====================

// Parse JSON from frontend
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enable CORS (allow frontend)
app.use(cors({
  origin: true, // allow all during development
  methods: ['GET', 'POST'],
  credentials: true
}));

// Request logger (helps debugging)
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// =====================
// ROUTES
// =====================

// Contact route → matches frontend fetch
app.use('/api/contact', contactRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Backend is running'
  });
});

// =====================
// ERROR HANDLING
// =====================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);

  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// =====================
// START SERVER
// =====================

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📧 Email: ${process.env.EMAIL_USER || 'Not configured'}`);
});