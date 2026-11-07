// Fix for ES6 __dirname and absolute .env path
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isRender = process.env.RENDER === 'true';

const envPath = path.resolve(__dirname, '.env');
const result = dotenv.config({ path: envPath });

// Render supplies secrets through the service environment, not a checked-in
// .env file. Treat every Render instance as production before importing app.js
// so CORS, cookies, proxy handling, and the listener use production settings.
if (isRender) process.env.NODE_ENV = 'production';

if (isRender) {
  // A local .env copied into Render (or localhost-only dashboard settings)
  // must not leave the hosted frontend outside the API's CORS allowlist or
  // generate verification/reset links back to localhost.
  const configuredOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const validOrigins = configuredOrigins.filter((origin) => {
    try {
      const parsed = new URL(origin);
      return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin;
    } catch {
      return false;
    }
  });
  const isLocalOrigin = (origin) => {
    try {
      return ['localhost', '127.0.0.1', '::1'].includes(new URL(origin).hostname);
    } catch {
      return true;
    }
  };
  const deployedFrontendOrigin = 'https://foliospace-drzx.onrender.com';
  const publicOrigin = validOrigins.find((origin) => !isLocalOrigin(origin))
    || deployedFrontendOrigin;
  process.env.FRONTEND_URL = [...new Set([
    publicOrigin,
    deployedFrontendOrigin,
    ...validOrigins.filter((origin) => !isLocalOrigin(origin))
  ])].join(',');
}

if (result.error) {
  if (isRender) {
    console.log('Render detected; using service environment variables (no .env file needed).');
  } else {
    console.error('⚠️  Warning: Could not find or load .env file at:', envPath);
    console.error('👉 Make sure you ran: cp .env.example .env');
  }
} else if (result.parsed) {
  console.log('✅ .env file loaded successfully. Parsed variables:', Object.keys(result.parsed));
}

// Solve Hoisting: Import the app ONLY after dotenv has initialized process.env
const { default: app } = await import('./app.js');

const PORT = process.env.PORT || (isRender ? 10000 : 5000);
// Keep local development bound to this machine. Hosted environments need to
// accept traffic from the platform's network interface.
const HOST = isRender
  ? '0.0.0.0'
  : (process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'));

app.listen(PORT, HOST, () => {
  console.log(`✅ Server listening on ${HOST}:${PORT} (${process.env.NODE_ENV || 'development'})`);
  console.log(`📡 Allowed Frontend URL: ${process.env.FRONTEND_URL || 'None (using reflect origin)'}`);
  console.log(`📧 Email configured: ${process.env.EMAIL_USER || '❌ NO'}`);
  console.log(`🔑 App Password set: ${process.env.EMAIL_PASSWORD ? '✅ YES' : '❌ NO'}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) })
      .then(async (response) => {
        const health = await response.json().catch(() => ({}));
        if (response.ok && health.status === 'OK') {
          console.log(`Portfolio API is already running on port ${PORT}; reusing that instance.`);
          process.exit(0);
        }
        console.error(`❌ Port ${PORT} is in use by another service. Set PORT to an available port or stop that service.`);
        process.exit(1);
      })
      .catch(() => {
        console.error(`❌ Port ${PORT} is already in use and the listener is not the portfolio API. Set PORT to an available port or stop that service.`);
        process.exit(1);
      });
    return;
  } else {
    console.error('❌ Server failed to start:', err.message);
  }
  process.exit(1);
});
