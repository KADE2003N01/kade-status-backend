import express from 'express';
import cors from 'cors';
import contactRoutes from './APIs/Contact/contact.routes.js'; // Correct path to Contact API routes

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [process.env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173', 'null'].filter(Boolean);
    if (!origin || process.env.FRONTEND_URL === '*' || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS Error: Origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
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