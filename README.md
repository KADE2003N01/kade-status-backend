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
- Node.js 16+ installed
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
FRONTEND_URL=http://localhost:3000
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-16-char-password
NODE_ENV=development
```

### 5. Start the Server
```bash
npm run dev
```

You should see:
```
╔════════════════════════════════════╗
║  🚀 Backend Server Running         ║
╠════════════════════════════════════╣
║  Port:        5000
║  Frontend:    http://localhost:3000
║  Email:       your-email@gmail.com
║  Env:         development
╚════════════════════════════════════╝
```

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
  "email": "your-email@gmail.com"
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
heroku config:set EMAIL_USER=your-email@gmail.com
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
EMAIL_USER=your-email@gmail.com
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
   - `EMAIL_USER=your-email@gmail.com`
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
heroku config:set EMAIL_USER=your-email@gmail.com
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
