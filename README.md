# Kade Portfolio Website Guide

This guide describes the website as it is implemented in this repository: how to run it, where its data lives, which project commands are available, how the API behaves, and what to check when something fails.

## Contents

- [How the website is organized](#how-the-website-is-organized)
- [Requirements and local setup](#requirements-and-local-setup)
- [Environment configuration](#environment-configuration)
- [Database and uploaded files](#database-and-uploaded-files)
- [Available project commands](#available-project-commands)
- [Admin workflow and limitations](#admin-workflow-and-limitations)
- [API reference](#api-reference)
- [Build, checks, and deployment](#build-checks-and-deployment)
- [Troubleshooting](#troubleshooting)
- [Safe maintenance notes](#safe-maintenance-notes)

## How the website is organized

The repository contains two Node.js projects:

| Folder | Role | Main technology |
| --- | --- | --- |
| `kade-status-frontend/` | Public portfolio pages and admin dashboard | React, Vite |
| `kade-status-backend/` | API, authentication, email, SQLite database, document storage | Express, better-sqlite3, Nodemailer |

The frontend is a multi-page React app. Vite serves pages such as `contact.html`, `document.html`, and `admin-login.html`, while the React app selects the page component based on the URL. In development, Vite forwards `/api` requests to the backend on port 5000. In production, the frontend host rewrites `/api/*` requests to the backend.

```text
Visitor or admin browser
        |
        | page requests and /api calls
        v
React/Vite frontend  ---- /api ---->  Express backend
                                         |       |
                                         |       +-- Gmail or configured SMTP
                                         +---------- SQLite and uploaded files
```

The backend source is organized by API area under `src/api/`; route registration is in `src/routes/index.js`. The SQLite schema is initialized by `src/database/database.js` when the backend starts. Admin tools in `scripts/` use the same configured database path.

## Requirements and local setup

Use Node.js 20 or later. There is no root `package.json`; install and run the frontend and backend from their own folders.

1. Open one terminal in `myportfolio/kade-status-backend` and install dependencies:

   ```powershell
   npm install
   ```

2. Copy `.env.example` to `.env`, then follow the comments in `.env.example` and the [Environment configuration](#environment-configuration) section. Keep `.env` private.

3. Start the backend once to initialize the database tables:

   ```powershell
   npm start
   ```

   The API listens on `http://localhost:5000` unless `PORT` is set. Leave this terminal running.

4. In a second terminal, open `myportfolio/kade-status-frontend` and install/start the frontend:

   ```powershell
   npm install
   npm run dev
   ```

5. Open the local URL printed by Vite. The local frontend API proxy targets `http://127.0.0.1:5000`. Admin pages include `admin-login.html`, `admin.html`, `admin-homepage.html`, `admin-documents.html`, and `admin-downloads.html`.

If PowerShell blocks the `npm` script, use `npm.cmd` (for example, `npm.cmd run admin:list`). Run commands from the correct project folder.

### Creating the first local admin

After the backend has initialized SQLite, open another terminal in `kade-status-backend` and run:

```powershell
npm run setup:check
npm run admin:add
npm run admin:list
```

`admin:add` asks for an email, display name, optional phone, and a password. Password input is hidden and the CLI requires at least 8 characters. If there are no tables yet, start the backend before running this command.

## Environment configuration

Use `.env.example` as the commented template. Copy it to `.env` for local use, replace the example email/password values, and restart the backend after editing it. On a hosting provider, set these values in that service's private environment settings instead of committing `.env`.

| Variable | What it controls |
| --- | --- |
| `PORT` | Backend HTTP port. Defaults to `5000`. |
| `NODE_ENV` | Use `development` locally and `production` on the deployed backend. |
| `FRONTEND_URL` | Comma-separated frontend origins allowed by CORS. Use exact origins with no trailing slash. Password recovery links use the first configured origin, so put the deployed frontend first in production. |
| `EMAIL_USER`, `EMAIL_PASSWORD` | SMTP identity and password for document verification and account recovery. For Gmail, use an App Password for the same account, not its normal password. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM` | Optional SMTP overrides for the general email service. Gmail is the default if `SMTP_HOST` is omitted. Port 587 normally uses `SMTP_SECURE=false`; port 465 normally uses `true`. |
| `CONTACT_EMAIL_USER`, `CONTACT_EMAIL_PASSWORD` | Optional separate SMTP account for the public contact form. If omitted, the general `EMAIL_*` settings are the fallback. |
| `CONTACT_NOTIFICATION_EMAIL` | Inbox that receives contact form messages. If omitted, the contact sender account (or general email account) is used. |
| `CONTACT_SMTP_HOST`, `CONTACT_SMTP_PORT`, `CONTACT_SMTP_SECURE`, `CONTACT_SMTP_FROM` | Optional SMTP overrides and sender for the contact form. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_DISPLAY_NAME`, `ADMIN_PHONE` | Bootstrap the first admin account when that email is not already in the database. Password must be at least 5 characters for bootstrap. |
| `ADMIN_EMAIL_2`, `ADMIN_PASSWORD_2`, `ADMIN_DISPLAY_NAME_2`, `ADMIN_PHONE_2` | Optional second bootstrap admin. Set email, password, and display name together. |
| `DATABASE_PATH` | SQLite file path. Absolute paths are recommended for deployed persistent storage. Relative paths resolve from the backend folder. |
| `STORAGE_DIR` | Root folder for uploaded profile images and PDFs. If `DATABASE_PATH` is blank, SQLite is stored here as `portfolio.sqlite`. |
| `PUBLIC_API_URL` | Optional HTTPS backend base used to generate direct profile-image URLs. Usually leave the local example value for local development. |
| `COOKIE_SAME_SITE` | Admin session cookie policy. `lax` is suitable for local development and the current same-origin production `/api` rewrite. |

The placeholders in `.env.example` cannot deliver email or create a usable admin login. Never paste real credentials into the example file, source code, README, or chat. If an email provider rejects credentials, check its code in the backend log; a configured value being present does not mean the provider accepted it.

## Database and uploaded files

SQLite is the application's database. The default local database is `kade-status-backend/data/portfolio.sqlite`. Set `DATABASE_PATH` to choose another file. If `DATABASE_PATH` is blank and `STORAGE_DIR` is set, the database is `<STORAGE_DIR>/portfolio.sqlite`.

The backend creates or updates the schema at startup. Main tables include:

| Table | Data stored |
| --- | --- |
| `admin_users`, `admin_sessions` | Admin accounts and active sessions. Passwords are stored as salted hashes. |
| `portfolio_settings` | Published homepage content as JSON. |
| `contact_messages` | Successfully emailed contact submissions: name, email, phone, message, and timestamp. |
| `portfolio_documents` | CV/certificate metadata and stored filenames. |
| `download_enquiries` | Visitor requests after email verification. |
| `download_email_verifications`, `download_verification_limits`, `download_access_tokens`, `document_preview_tokens` | Temporary verification challenges, anti-abuse limits, and short-lived download or one-use preview authorization. |
| `admin_password_resets` | Hashed, expiring password-reset tokens. |

Contact messages include personal information. They are included in the owner notification email and saved to SQLite after the email delivery call completes. There is currently no admin page or API endpoint for browsing the `contact_messages` table; `db:inspect` shows only its row count.

Uploaded profile images and administrator-uploaded PDFs are stored as files, while their references/metadata are stored in SQLite. Local files are under the backend folder. For Render, attach a persistent disk to the **backend web service**, mount it at `/var/data`, and set:

```text
STORAGE_DIR=/var/data
DATABASE_PATH=/var/data/portfolio.sqlite
```

Without persistent storage, local SQLite data and uploaded files can disappear when the service restarts or redeploys. A local `.env` and local SQLite file do not configure or update the hosted database. Back up/migrate an existing database before switching its configured path; starting with a new empty database does not copy the old records.

## Available project commands

These are project-specific npm shortcuts in this backend's `package.json`; they are not built-in SQLite commands. Run them from `kade-status-backend`:

| Command | What it does |
| --- | --- |
| `npm start` | Starts the backend server. |
| `npm run setup:check` | Reports the backend folder, configured database path, and whether the database contains admins. Does not print secrets. |
| `npm run admin:list` | Lists admin IDs, emails, display names, and creation dates; does not display password hashes. |
| `npm run admin:add` | Interactively adds an admin. Password entry is hidden. |
| `npm run setup:admin` | Alias for `admin:add`. |
| `npm run admin:reset-password` | Changes an existing admin's password and revokes that admin's active sessions. Password entry is hidden. |
| `npm run db:inspect` | Lists database tables and row counts, not the table contents. |
| `npm test` | Runs the backend Node test suite. |

The project does **not** currently provide `admin:update`, `admin:delete`, or `db:backup` commands. The admin portal also does not currently edit or delete admin accounts. Changing `ADMIN_*` values in `.env` does not update an account that already exists in SQLite. Avoid manual `DELETE` or `UPDATE` SQL unless you have a verified backup and know which database file the running app uses.

These commands operate on the local database path resolved from that command's environment. They do not automatically connect to Render's database. To manage production data, use an approved maintenance connection to the production service/disk or the application admin interface. Do not download or expose the production SQLite file casually; it contains account and visitor data.

## Admin workflow and limitations

### Homepage edits

1. Open **Landing page** in the admin portal and edit the fields.
2. Select **Save & review** to prepare the preview.
3. In the review screen select **Publish to homepage** to write the content to SQLite and make it public.

The first action alone is only a browser-side draft. **Restore defaults** intentionally replaces the published homepage content. Signing in or out does not modify published homepage content.

### Documents and visitor requests

- CV and certificate uploads require valid PDF files and admin authentication. The upload size limit is 10 MB.
- The admin **Downloads & enquiries** page lists verified document requests and permits deletion of a request.
- Visitors must verify their email before previewing or downloading a document. A preview does not create an admin request or save visitor details alongside the document; the email is used to send the code, and the anti-abuse limiter retains a hashed email and IP address. Verified downloads are recorded in the admin portal.
- The admin **Accounts** page lists admins and can send a password-reset link. It cannot edit or delete accounts.
- The admin **My profile** page displays account details and can publish an image for the admin only, both admin and public visitors, or public visitors only. Its three checkbox choices are mutually exclusive and use one **Publish image** button. Private admin images are returned only from an authenticated route.

### Shared language and phone controls

- The frontend keeps the shared language selector and translations in `kade-status-frontend/src/components/LanguageSelector.jsx` and `src/context/LanguageContext.jsx`. English, French, and Kiswahili are available. Visitor and admin preferences are saved separately in browser local storage, so changing one does not change the other.
- The shared phone field is in `kade-status-frontend/src/components/PhoneNumberField.jsx` and is used in the contact form, document request form, and admin homepage contact-phone setting. It offers international country calling codes, displays country names in the selected language, and sends numbers in E.164 format.
- The country selection applies only to phone-number input; it does not limit website visitors by country or IP address. The frontend and backend validate the international number before use. A valid number format does not prove that the number is active or reachable. Changing the published contact number also updates the footer call link and WhatsApp link.
- The language selector translates the interface text that has translations in the language catalog. Admin-authored homepage copy, document titles, and other visitor-provided content remain as entered; they are not automatically translated.

## API reference

All API routes are mounted beneath `/api`. Authenticated routes require the admin session cookie or supported bearer session token.

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /` | Public | Backend service identity. |
| `GET /api/health` | Public | Health check (`{ "status": "OK" }`). |
| `GET /api/homepage` | Public | Published homepage content and update timestamp. |
| `PUT /api/homepage` | Admin | Validate and publish homepage content. |
| `POST /api/homepage/reset` | Admin | Restore default homepage content. |
| `POST /api/homepage/profile-image` | Admin | Upload JPG, PNG, or WebP profile image (maximum 5 MB); `visibility` is `admin`, `both`, or `public`. |
| `GET /api/homepage/admin-profile-image` | Admin | Serve the admin-only image, or return no image when the admin visibility choice is public-only. |
| `GET /api/homepage/profile-image/:filename` | Public | Retrieve an uploaded profile image. |
| `POST /api/contact/` | Public | Submit name, email, international phone number, and message; validates input, normalizes the phone number, emails it, and saves it to SQLite after delivery. |
| `GET /api/contact/status` | Public | Reports contact mail configuration and SMTP connection status. |
| `POST /api/auth/login` | Public | Sign in and create an admin session. |
| `GET /api/auth/me` | Admin | Return the current admin's email and display name. |
| `POST /api/auth/logout` | Public | Revoke the current session. |
| `GET /api/auth/admin-users` | Admin | List admin accounts. |
| `POST /api/auth/admin-users/:adminId/password-reset` | Admin | Email a password-reset link to the selected account. |
| `POST /api/auth/password-reset/request` | Public | Request an account recovery email. |
| `POST /api/auth/password-reset/confirm` | Public | Confirm a valid recovery token and change password. |
| `GET /api/documents` | Public | List published CV/document/certificate metadata. |
| `POST /api/documents/cv` | Admin | Publish a CV PDF and metadata. |
| `POST /api/documents/certificates` | Admin | Publish a certificate PDF and metadata. |
| `PUT /api/documents/certificates/:documentId` | Admin | Update a published document's metadata or replace its PDF (the route currently handles CVs and other document types too). |
| `DELETE /api/documents/:documentId` | Admin | Delete a published document and its file. |
| `POST /api/downloads/request` | Public | Start email verification for a preview or download (`purpose: "preview"` or `"download"`). |
| `POST /api/downloads/verify` | Public | Verify the emailed six-digit code. |
| `GET /api/downloads/preview/:documentId` | Disabled | Returns `403`; direct previews are blocked. |
| `POST /api/downloads/preview` | Public | Preview a PDF using the short-lived token returned after email verification. |
| `POST /api/downloads/file` | Public | Consume authorization and download a private PDF. |
| `POST /api/downloads/file-failed` | Public | Report a failed download so its status can be updated. |
| `GET /api/downloads` | Admin | List visitor download requests. |
| `DELETE /api/downloads/:downloadId` | Admin | Delete a visitor request and its associated tokens. |

The contact JSON body is:

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "phone": "+250 788 950 833",
  "message": "I would like to discuss a project opportunity."
}
```

Phone numbers may include spaces, parentheses, periods, hyphens, and a leading `+`. They must contain 7 to 15 digits. The form asks visitors to include a country code.

For previews, only an email address and consent are required. The backend emails a verification code, then issues a one-use preview token after a valid code; it does not add the visitor to the admin request list or keep their email with the document. The anti-abuse limiter keeps a hashed email/IP pair. For downloads, the form also requires the visitor's name, phone number, and reason, and verified requests are recorded for admins. Codes expire after 10 minutes, allow five attempts, and code requests are limited to three per email/IP pair in a 15-minute window.

## Build, checks, and deployment

### Local checks

Backend checks from `kade-status-backend`:

```powershell
npm test
npm run setup:check
npm run db:inspect
```

Frontend checks from `kade-status-frontend`:

```powershell
npm test
npm run build
```

The frontend build writes static assets to `kade-status-frontend/dist`. Its Vite configuration also generates page shells for the public and admin URLs. Deploy the built `dist` folder as the static site.

### Current Render layout

The frontend and backend can stay in separate GitHub repositories and Render services. The frontend repository's `render.yaml` builds the static site and rewrites `/api/*` to `https://kade-status-backend-e1th.onrender.com/api/*`. This backend repository's `render.yaml` builds and starts the API and checks `/api/health`.

For the backend Render Web Service, connect the backend repository, leave **Root Directory** blank when its root contains this `package.json`, use `npm ci` as the build command, and `npm start` as the start command. `nodemailer` is a production dependency in both `package.json` and `package-lock.json`, so `npm ci` from this folder installs it. If the runtime log still says Nodemailer is missing, inspect the latest **build** log and confirm it ran `npm ci` in this repository and branch; then redeploy with a cleared build cache.

Set production environment variables in the backend service's Render dashboard, not in GitHub. At minimum, set `FRONTEND_URL` to the exact deployed frontend origin. Add `EMAIL_USER` and a Gmail App Password as `EMAIL_PASSWORD` for account recovery and verification email; add contact-specific settings if the contact form uses another mailbox. Missing email settings do not prevent the API from starting, but email features will return a configuration error until they are set. Keep the backend's persistent disk and its `STORAGE_DIR`/`DATABASE_PATH` settings configured separately so deploys preserve uploaded files and database data.

The backend allows the known production frontend origin plus local development origins. Set `FRONTEND_URL` when using another frontend domain. Keep `FRONTEND_URL` exact and comma-separated; do not use `*` for authenticated requests.

When changing persistent database paths, preserve the previous database and uploaded files until the new location is confirmed. A redeploy cannot recover data that was already erased from an ephemeral filesystem.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Local API connection refused | Start `npm start` in the backend. The frontend proxy expects port 5000. Check `PORT` if using another port. |
| Admin login says no admin exists | Run `npm run setup:check`; confirm it reports the database file you intend to use. Start the backend to create tables, then run `npm run admin:add`. |
| Admin login rejects correct credentials | Confirm frontend points to the intended backend and that the admin exists in that backend's database. Environment bootstrap credentials do not overwrite an existing account. |
| Contact form cannot send | Check required phone format, backend logs, `CONTACT_EMAIL_*` and `CONTACT_NOTIFICATION_EMAIL`; if contact settings are omitted, check `EMAIL_*`. For Gmail, use an App Password and restart after changing secrets. |
| Contact form succeeds but confirmation email is absent | The owner notification can succeed while the visitor confirmation fails. Check backend logs and the visitor's spam folder. The message is still saved and sent to the owner. |
| Browser reports CORS failure | Add the exact frontend origin to `FRONTEND_URL` and restart the backend. The origin includes scheme and optional port, but no path or trailing slash. |
| Homepage edit is not visible | Complete both **Save & review** and **Publish to homepage**. Check that the browser is using the same backend as the admin session. |
| Data disappears after a hosted restart/deploy | Confirm the backend has a persistent disk mounted and both `STORAGE_DIR` and `DATABASE_PATH` point to it. Local database files are separate from production. |
| Uploaded profile image/document is missing | Check persistent `STORAGE_DIR`, the corresponding file on the backend disk, and the database record. Metadata in SQLite alone does not contain the PDF/image bytes. |
| Forgot admin password | Use the reset page or `npm run admin:reset-password` against the correct local database. Recovery email requires working general `EMAIL_*` settings. |

## Safe maintenance notes

- `cleanup-docs.mjs` is a destructive cleanup utility, not an npm shortcut. It deletes document rows when it cannot find their files in `private-documents`. Review the script and make a verified backup before running it; its path assumptions may not match a custom `STORAGE_DIR`.
- Do not edit password hashes manually. Use `npm run admin:reset-password` for a local account or the recovery flow for the hosted account.
- Before manual database maintenance, identify the exact database file using `npm run setup:check`. Stop the backend before copying a local SQLite file with ordinary file-copy tools. Do not point a local app at production data unintentionally.
- `db:inspect` reports counts, not contact contents. There is no built-in database backup, admin update, or admin delete shortcut at present.
- Keep `.env`, SQLite files, and uploaded private PDFs out of Git. Use hosting-provider secret settings for production credentials and rotate any credential that was exposed.
- The project uses SQLite and one backend database file. If deploying multiple backend instances, they must not each use separate local SQLite files; use one supported shared/persistent data design before scaling out.
