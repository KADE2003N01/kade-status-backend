import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import contactRoutes from './APIs/Contact/contact.routes.js'; // Correct path to Contact API routes
import authRoutes from './APIs/Auth/auth.routes.js';
import downloadRoutes from './APIs/Downloads/downloads.routes.js';
import documentRoutes from './APIs/Documents/documents.routes.js';
import homepageRoutes from './APIs/Homepage/homepage.routes.js';

const app = express();

// Middleware
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const localDevelopmentOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5175',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
];
const configuredOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin && origin !== '*');
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? configuredOrigins
  : [...new Set([...localDevelopmentOrigins, ...configuredOrigins])];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS Error: Origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));

// Request Logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// API Registration
app.get('/', (req, res) => res.json({ success: true, message: 'Kade API v1' }));
app.get('/api/health', (req, res) => res.json({ status: 'OK' }));

// [APIs Registration] - Register your API modules here
app.use('/api/contact', contactRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/downloads', downloadRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/homepage', homepageRoutes);
// app.use('/api/blog', blogRoutes); // How you would add more APIs

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found`
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('❌ Server Error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

export default app;