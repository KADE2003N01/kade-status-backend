import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import apiRoutes from './src/routes/index.js';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
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
  .filter(Boolean);
for (const origin of configuredOrigins) {
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error('FRONTEND_URL must contain exact HTTP or HTTPS origins separated by commas.');
  }
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
    throw new Error('FRONTEND_URL must contain exact HTTP or HTTPS origins without paths or trailing slashes.');
  }
}
const allowedOrigins = new Set([
  ...configuredOrigins,
  ...(!isProduction ? localDevelopmentOrigins : [])
]);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
    } else {
      const error = new Error('Origin is not allowed by CORS.');
      error.status = 403;
      callback(error);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true
}));

app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: 'Too many requests. Please try again later.'
  })
}));

// Request Logger
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  }
  next();
});

// API Registration
app.get('/', (req, res) => res.json({ success: true, message: 'Kade API v1' }));
app.get('/api/health', (req, res) => res.json({ status: 'OK' }));
app.use('/api', apiRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found`
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600
    ? err.status
    : 500;
  console.error('Server error:', err.message);
  res.status(status).json({
    success: false,
    error: status >= 500 && isProduction
      ? 'Internal server error'
      : err.message || 'Internal server error'
  });
});

export default app;
