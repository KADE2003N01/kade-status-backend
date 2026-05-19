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

import app from './app.js';

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 Allowed Frontend URL: ${process.env.FRONTEND_URL || 'None (using reflect origin)'}`);
  console.log(`DEBUG: process.env.EMAIL_USER = "${process.env.EMAIL_USER}"`);
  console.log(`DEBUG: process.env.EMAIL_PASSWORD = "${process.env.EMAIL_PASSWORD ? '********' : 'Not set'}"`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Error: Port ${PORT} is already in use. Run 'fuser -k ${PORT}/tcp' to clear it or change PORT in .env`);
  } else {
    console.error('❌ Server failed to start:', err.message);
  }
  process.exit(1);
});