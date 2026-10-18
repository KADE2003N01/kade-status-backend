# Kade Status Backend

A simple Express.js backend for handling contact form submissions via email using Gmail's SMTP server.

## 📋 Features

- ✅ Contact form email submission
- ✅ Sends confirmation email to visitor
- ✅ Sends notification email to site owner
- ✅ CORS support for frontend integration
- ✅ Input validation & XSS protection
- ✅ Health check endpoint
- ✅ Error handling & logging

## 🚀 Quick Setup (5 minutes)

### 1. Prerequisites
- Node.js 20+ installed
- Gmail account with 2-Step Verification enabled

### 2. Install Dependencies
```bash
cd Client-Side/kade-status-backend
npm install
```

### 3. Setup Gmail App Password
1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Enable "2-Step Verification" (if not already done)
3. Go to "App passwords" section
4. Select "Mail" and "Windows Computer" (or your device)
5. Generate and copy the 16-character password

### 4. Create .env File
```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```
PORT=5000
FRONTEND_URL=http://localhost:5500,http://127.0.0.1:5500
EMAIL_USER=kadecomputerscience@gmail.com
EMAIL_PASSWORD=your-16-char-password
# Optional: set these to use an SMTP provider other than the Gmail default
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_FROM=verified-sender@example.com
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_FROM_NUMBER=+15017122661
ADMIN_EMAIL=kadecomputerscience@gmail.com
ADMIN_PASSWORD=replace-with-your-own-password
ADMIN_DISPLAY_NAME=David KWIZERA
DATABASE_PATH=data/portfolio.sqlite
PUBLIC_API_URL=https://api.example.com
COOKIE_SAME_SITE=lax
NODE_ENV=development
```

`PUBLIC_API_URL` is optional. Without it, uploaded profile images use a same-origin `/api/...` URL, which works with the local Vite proxy and the Render frontend rewrite. Set it to the public backend origin (without a trailing `/api`) only when you need image URLs to point directly to a separate API domain.

For Render production, attach a persistent disk to the backend web service, mount it at `/var/data`, and set `STORAGE_DIR=/var/data` and `DATABASE_PATH=/var/data/portfolio.sqlite` in the service environment. Profile images and uploaded documents are written under `STORAGE_DIR`; SQLite uses `DATABASE_PATH`. Without a persistent disk, uploads and local database changes can be lost on service restart or redeploy. `STORAGE_DIR` is optional for local development.

The first server start creates the administrator account in SQLite from the `ADMIN_*` values. The password is stored as a salted scrypt hash; the administrator display name is read from the database after sign-in. Once the account exists, sign-in uses the database record and does not require the `ADMIN_*` values to remain configured. Changing bootstrap environment values does not overwrite an existing administrator record. The database file is excluded from Git; production hosting must provide persistent storage for `DATABASE_PATH`.

`ADMIN_PASSWORD` must contain at least 5 characters when bootstrapping an administrator. This low minimum is a security tradeoff; use a longer, unique password wherever possible.

The downloadable CV and EBC PDF files live in `private-documents/`, outside the public frontend assets. CV and certificate PDFs uploaded through the admin dashboard are stored in that same private directory, while their public display details are stored in SQLite. Profile images uploaded from the landing-page editor are checked for supported image signatures and saved under the backend's `profile-images/` directory. Keep these backend assets deployed and back them up with the database.

For an existing installation, update the administrator's email in the SQLite `admin_users` table as well as changing `ADMIN_EMAIL`; changing the bootstrap setting alone does not change the stored login email.

### Reset an administrator password

From the backend directory, run `npm run admin:reset-password`. Enter the administrator's email and a new password of at least 12 characters when prompted. Password input is hidden, the database stores only a salted hash, and existing sessions for that administrator are revoked. The command uses `DATABASE_PATH` from `.env` or the default `data/portfolio.sqlite` database.

### Quick database commands

Run these from the backend directory:

- `npm run admin:list` lists administrator email addresses, display names, and creation dates. It never displays password hashes.
- `npm run admin:add` adds an administrator directly to SQLite. Enter their email and display name, then a new password of at least 12 characters when prompted. Password input is hidden.
- `npm run db:inspect` lists database tables and their row counts without printing their contents.
- `npm run admin:reset-password` resets an existing administrator password and revokes that administrator's sessions.

These commands use the same SQLite file configured by `DATABASE_PATH` in `.env`.

The deployed frontend origin (`https://david-portifolio.onrender.com`) and the supported local development origins are allowed by default. `FRONTEND_URL` can add exact frontend origins, separated by commas. Do not use `*` for authenticated requests.

### 5. Start the Server
```bash
npm start
```

Run the backend with `npm start`, then run the React frontend from `kade-status-frontend` with `npm install` and `npm run dev` in a second terminal. Open the URL printed by Vite and visit `src/admin-login.html`. Vite proxies local `/api` requests to the backend at `http://127.0.0.1:5000`. For Render production, the frontend's `render.yaml` rewrites `/api/*` to the Render backend while keeping the browser on the frontend origin; this lets mobile browsers store the admin session cookie as a first-party cookie. The local frontend tries `http://localhost:5000/api` first and falls back to the deployed Render API when the local backend is unavailable. Set `VITE_PORTFOLIO_API_BASE_URL` only when intentionally overriding these API URLs.

## Admin Authentication

- `POST /api/auth/login` accepts `{ "email": "...", "password": "..." }` and issues an HTTP-only session cookie.
- `GET /api/auth/me` returns the signed-in administrator's database-backed display name and email.
- `POST /api/auth/logout` revokes the current server-side session.
- `GET /api/homepage` returns the public landing-page content.
- `PUT /api/homepage` lets an authenticated admin publish landing-page text, images, links, cards, and section visibility to the shared database.
- `POST /api/homepage/reset` restores the default landing-page content for authenticated admins.
- `POST /api/downloads/request` validates a visitor's name, selected email/SMS recipient, purpose, and consent, then sends a one-time code via the selected channel. It does not create a request or issue download authorization until the recipient is verified.
- `POST /api/downloads/verify` accepts `{ "challengeId": "...", "code": "123456" }`; codes expire after 10 minutes and allow five attempts. Code requests are limited to three per recipient/IP pair per 15-minute window. Configure email or Twilio delivery as described below; missing configuration or delivery errors do not grant access.
- `POST /api/downloads/preview` displays a document inline using that authorization.
- `GET /api/downloads/preview/:documentId` lets visitors view a published PDF inline without creating a download request; downloading remains gated by the verified contact form.
- `POST /api/downloads/file` consumes the short-lived authorization and delivers the requested private file.
- `GET /api/downloads` returns recent download requests to authenticated admins only.
- `DELETE /api/downloads/:downloadId` removes a visitor request and its associated download tokens for authenticated admins.
- `GET /api/documents` returns the public CV, EBC document, and certificates.
- `POST /api/documents/cv` lets an authenticated admin publish a replacement CV PDF (up to 10 MB) with its visitor-facing title, description, issue date, and institution.
- `POST /api/documents/certificates` lets an authenticated admin publish a certificate PDF and its title, description, issue date, and institution.
- `PUT /api/documents/certificates/:documentId` lets an authenticated admin update certificate details or replace its PDF.
- `POST /api/homepage/profile-image` accepts an authenticated JPG, PNG, or WebP profile-image upload (up to 5 MB) and updates the published landing-page image.
- Invalid sign-ins are rate limited to five attempts per IP address per 15-minute window.
- Sessions expire after eight hours. Keep `.env` and the SQLite database private, use HTTPS in production, and keep a persistent disk mounted for SQLite.

The visitor download form requires `documentId`, `name`, `reason` (10–1,000 characters), exactly one contact method (`email` or `phone`), `channel` (`email` or `sms`), and `consent: true`. Visitors enter their own email or phone number; the matching send-code button is shown, and the code is delivered to that selected contact. The server rejects requests that include both contact methods, and only the verified email or phone is retained as the visitor's follow-up contact. A successful `/api/downloads/request` returns only a `challengeId` and expiry; the actual one-time code is never sent back to the browser. The visitor must enter the real six-digit code received by email or SMS and pass `/api/downloads/verify` before receiving the short-lived download token. Gmail uses `EMAIL_USER` and a Gmail app password in `EMAIL_PASSWORD` (with 2-Step Verification enabled). To use a different SMTP provider, also set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` (`true` or `false`), and optionally `SMTP_FROM`. SMS verification requires Twilio `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`; use an active Twilio sender authorized for your account and destination region. Add these values to the backend's private `.env` or hosting-provider secret settings, restart the backend after changing them, and never run the test environment in production. The `.env.example` values are placeholders and cannot deliver messages.

The request endpoint reports success only after the email or SMS provider accepts the message. If delivery fails, it removes the temporary challenge and releases that request's rate-limit reservation so the visitor can retry; delivery logs contain provider error codes only, not message content, OTPs, or recipient details.

If Gmail returns `EAUTH` with response code `535`, Gmail has rejected the configured SMTP credentials. `EMAIL_PASSWORD` must be a Google App Password generated for the same account in `EMAIL_USER` (not the account's regular password); App Passwords require Google 2-Step Verification. Replace the value privately in `.env`, ensure it has no surrounding quotes or accidental whitespace, and restart the backend. The startup message only confirms that a value is present, not that Gmail accepts it. Never paste the password into terminal output, source code, or chat.

The admin dashboard's **Landing page** editor publishes shared content for all site visitors. It controls the page title and description, branding and navigation, hero text and media, introduction, highlight cards, document call-to-action, footer links and contact details, and section visibility. Lists (navigation, cards, and footer links) are edited as JSON in the dashboard. The default page content is restored with the editor's **Restore defaults** action.

## 📡 API Endpoints

### POST /api/contact/send
Send a contact form submission.

**Request:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "message": "Hello, I'm interested in your services!"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Email sent successfully",
  "data": {
    "name": "John Doe",
    "email": "john@example.com",
    "timestamp": "2024-01-01T12:00:00.000Z"
  }
}
```

**Error Response (400/500):**
```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

### GET /api/health
Check if the server is running.

**Response:**
```json
{
  "status": "OK",
  "message": "Backend server is running",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### GET /api/contact/status
Check if email service is configured.

**Response:**
```json
{
  "configured": true,
  "email": "kadecomputerscience@gmail.com"
}
```

## 📁 Project Structure

```
Client-Side/kade-status-backend/
├── server.js              # Main Express server
├── routes/
│   └── contact.js         # Contact form handler
├── package.json           # Dependencies
├── .env                   # Environment variables (with credentials)
├── .env.example           # Template reference
├── .gitignore             # Git configuration
└── README.md              # This file
```

## 🧪 Testing

### Option 1: Using cURL
```bash
curl -X POST http://localhost:5000/api/contact/send \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "message": "This is a test message"
  }'
```

### Option 2: Using your portfolio website
1. Navigate to your portfolio contact page
2. Fill in the form and submit
3. Check your email for confirmation

## 🐛 Troubleshooting

### "Connection refused" error
**Problem:** Backend not running
**Solution:** Make sure you ran `npm run dev` in the backend folder

### "Invalid app password" error
**Problem:** Gmail authentication failed
**Solution:** 
- Verify you generated the app password correctly
- Ensure it's exactly 16 characters
- Make sure 2FA is enabled on your Google account
- Copy the password exactly (no extra spaces)

### CORS error in browser console
**Problem:** Frontend and backend not communicating
**Solution:**
- Update `FRONTEND_URL` in `.env` to match your frontend URL
- For localhost: `FRONTEND_URL=http://localhost:3000`
- For production: `FRONTEND_URL=https://your-domain.com`

### Emails not being sent
**Problem:** Email service not working
**Solution:**
1. Check `.env` file has correct EMAIL_USER and EMAIL_PASSWORD
2. Make sure 2-Step Verification is enabled on Gmail
3. Verify the app password is correct
4. Check spam/trash folder
5. Run `GET /api/contact/status` to check configuration

## 🌍 Deployment

### Render.com (Recommended - Free tier available)
1. Push code to GitHub
2. Create account at [render.com](https://render.com)
3. Connect GitHub repository
4. Create new Web Service
5. Set environment variables in Render dashboard
6. Deploy!

### Railway.app
1. Push code to GitHub
2. Create account at [railway.app](https://railway.app)
3. Connect GitHub
4. Add environment variables
5. Deploy!

### Heroku (Note: Free tier ended, paid only)
```bash
npm install -g heroku
heroku login
heroku create your-app-name
git push heroku main
heroku config:set EMAIL_USER=kadecomputerscience@gmail.com
heroku config:set EMAIL_PASSWORD=your-password
heroku config:set FRONTEND_URL=https://your-domain.com
```

## 📚 Learn More

- [Express.js Documentation](https://expressjs.com/)
- [Nodemailer Guide](https://nodemailer.com/)
- [Gmail App Passwords](https://support.google.com/accounts/answer/185833)
- [CORS Documentation](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)

## 📝 Security Notes

- ✅ Always keep `.env` file in `.gitignore`
- ✅ Never commit passwords or secrets to Git
- ✅ Use environment variables for sensitive data
- ✅ Input validation prevents injection attacks
- ✅ HTML escaping prevents XSS attacks
- ✅ CORS configured to accept only your frontend

## 📄 License

MIT License - Feel free to use this project

## 👤 Author

Kade - Portfolio Backend

---

**Need help?** Check the troubleshooting section or review the setup guide!
# Kade Portfolio Backend

A simple Node.js/Express backend for handling contact form submissions on your portfolio.

## What This Does

- Receives form submissions from your portfolio website
- Sends you an email notification with the visitor's message
- Sends the visitor a confirmation email
- Handles validation and error handling

## Installation & Setup

### 1. Install Dependencies
```bash
cd kade-status-backend
npm install
```

### 2. Configure Email (Gmail)

This backend uses Gmail to send emails. Follow these steps:

**Step A: Enable 2-Factor Authentication**
- Go to [Google Account](https://myaccount.google.com)
- Click "Security" in the left menu
- Enable "2-Step Verification"

**Step B: Generate App Password**
- After enabling 2FA, go back to Security
- Find "App passwords"
- Select "Mail" and "Windows Computer" (or your device)
- Google will generate a 16-character password
- Copy this password

**Step C: Create .env File**
```bash
cp .env.example .env
```

Then edit `.env` and add:
```
PORT=5000
FRONTEND_URL=http://localhost:3000
EMAIL_USER=kadecomputerscience@gmail.com
EMAIL_PASSWORD=your-app-password-here
```

### 3. Run Backend

**Development (with auto-refresh):**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

Backend will run on `http://localhost:5000`

## Testing Locally

1. Start the backend: `npm run dev`
2. The frontend will send requests to `http://localhost:5000/api/contact/send`
3. Submit the contact form and check your email

## Deployment

### Option 1: Deploy to Render (Recommended)

1. Push code to GitHub
2. Go to [Render.com](https://render.com)
3. Click "New +" → "Web Service"
4. Select your GitHub repo
5. Set environment variables:
   - `PORT=5000`
   - `EMAIL_USER=kadecomputerscience@gmail.com`
   - `EMAIL_PASSWORD=your-app-password`
   - `FRONTEND_URL=https://your-portfolio-url.com`
6. Deploy!

### Option 2: Deploy to Railway

1. Go to [Railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub"
3. Select your repo
4. Add environment variables (same as above)
5. Deploy!

### Option 3: Deploy to Heroku

```bash
heroku login
heroku create your-app-name
git push heroku main
heroku config:set EMAIL_USER=kadecomputerscience@gmail.com
heroku config:set EMAIL_PASSWORD=your-app-password
```

## Frontend Integration

Update your contact form to POST to your backend. Replace the form action in `src/contact.html`:

```javascript
document.querySelector('.contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const formData = {
    name: document.querySelector('input[placeholder="Your Name"]').value,
    email: document.querySelector('input[placeholder="Your Email"]').value,
    message: document.querySelector('textarea').value
  };
  
  try {
    const response = await fetch('http://localhost:5000/api/contact/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    });
    
    const data = await response.json();
    if (data.success) {
      alert('Message sent! Check your email for confirmation.');
      e.target.reset();
    } else {
      alert('Error: ' + data.error);
    }
  } catch (error) {
    alert('Failed to send message. Please try again.');
  }
});
```

## Endpoints

- **POST** `/api/contact/send` - Submit contact form
- **GET** `/api/health` - Check if backend is running

## Troubleshooting

**"Failed to send email"**
- Check EMAIL_USER and EMAIL_PASSWORD in .env
- Ensure Gmail App Password is correct (16 characters)
- Make sure 2FA is enabled on Gmail account

**CORS errors**
- Update FRONTEND_URL in .env to match your frontend URL
- For local testing, it's already set to http://localhost:3000

**Port already in use**
- Change PORT in .env to another number (e.g., 5001)
