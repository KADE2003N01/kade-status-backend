// Fix for ES6 __dirname and absolute .env path
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.resolve(__dirname, '.env');
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error('⚠️  Warning: Could not find or load .env file at:', envPath);
  console.error('👉 Make sure you ran: cp .env.example .env');
} else if (result.parsed) {
  console.log('✅ .env file loaded successfully. Parsed variables:', Object.keys(result.parsed));
}

// Solve Hoisting: Import the app ONLY after dotenv has initialized process.env
const { default: app } = await import('./app.js');

const PORT = process.env.PORT || 5000;
// Keep local development bound to this machine. Hosted environments need to
// accept traffic from the platform's network interface.
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

app.listen(PORT, HOST, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Allowed Frontend URL: ${process.env.FRONTEND_URL || 'None (using reflect origin)'}`);
  console.log(`📧 Email configured: ${process.env.EMAIL_USER || '❌ NO'}`);
  console.log(`🔑 App Password set: ${process.env.EMAIL_PASSWORD ? '✅ YES' : '❌ NO'}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Reuse the running API with the portfolio dev stack, or set PORT to an available port before starting this server.`);
  } else {
    console.error('❌ Server failed to start:', err.message);
  }
  process.exit(1);
});
