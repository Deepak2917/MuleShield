# MuleShield

**See the Network. Stop the Mule.**

MuleShield is an in-progress financial investigation workspace. The current implemented slice provides a public product page, a protected React dashboard, local and administrator account provisioning, administrator-managed account activation, server-backed password authentication, mandatory TOTP enrollment and verification, one-time recovery codes, session cookies, password changes, administrator-only user/audit APIs, and case-based CSV investigation workflows. Dashboard counts and monitoring signals remain synthetic demo content. There is no connected bank or Kafka source.

## Requirements

- Node.js 24+ (Node's built-in `node:sqlite` is used by the local API)
- npm

## Local setup

1. Copy `.env.example` to `.env`.
2. Generate a 32-byte encryption key using PowerShell:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Set `MULESHIELD_ENCRYPTION_KEY` in `.env` to the generated 64-character hex value. Never commit `.env` or reuse this key across environments. Losing it makes encrypted MFA secrets unavailable.
4. Install packages using `npm install --cache F:\npm-cache` if the default system drive is low on space.
5. Start frontend and API together with `npm run dev`. The Vite server proxies `/api` requests to the local API on port 3001.
6. In a separate local terminal, run `npm run provision:user` once for the demo Administrator and again for the demo Analyst. Enter distinct demo email addresses, select the requested role, and enter a different strong password (14–128 characters) from a password manager each time. Password input is not echoed. The script inserts only; duplicate email addresses are rejected and existing accounts are not modified. Do not put demo passwords in source files or commit them.
7. Open the Vite URL (normally `http://localhost:5173`) and sign in. An account without MFA is restricted to the required enrollment flow; normal workspace access begins only after server verification. Save the displayed recovery codes securely.

The API requires the encryption key even if no user has MFA enabled. SQLite data is stored in `data/muleshield.sqlite` by default; set `MULESHIELD_DB_PATH` to change this location. This local database is ignored by Git. Set `PORT` to change the API port and `HOST` to change its bind address; the local default is `127.0.0.1`. `SESSION_HOURS` sets session expiry. Production additionally needs `NODE_ENV=production` and the exact `APP_ORIGIN`.

## Local demo accounts and data

To prepare two local demo identities without changing existing credentials, run `npm run provision:user` twice in an interactive terminal. For the first account choose `ADMINISTRATOR`; for the second choose `ANALYST`. Use demo-only emails and strong, unique passwords stored in a password manager. Neither command output nor the application reveals passwords. On first login, both accounts must enroll an authenticator and verify its code before receiving normal workspace access. Keep recovery codes in a secure local vault. An Administrator can use `/app/admin` to list/search users, provision additional users, change roles, activate/deactivate accounts, and review the audit events returned by the backend. Administrative changes revoke affected sessions and are checked by the API.

The default SQLite file is `data/muleshield.sqlite` (or `MULESHIELD_DB_PATH`). It persists across app restarts and contains `users`, `sessions`, `mfa_challenges`, `mfa_enrollment_challenges`, `audit_events`, `investigations`, `transactions`, `findings`, `investigation_notes`, and `monitoring_state`. SQLite WAL sidecar files may appear while the service is running. Do not remove the database or its WAL files to reset a demo; create separate test data only through the app or a separately configured test database.

## Security notes

- API routes use server-side roles, SQLite parameterized statements, scrypt password hashes, AES-256-GCM encrypted TOTP secrets, hashed single-use recovery codes, short-lived MFA challenges, rate limits, and HttpOnly/SameSite=Strict session cookies.
- Production cookies are marked Secure when `NODE_ENV=production`; production deployment must use HTTPS and set `APP_ORIGIN` to the exact application origin.
- This is not a security-reviewed production identity system. The first Administrator is provisioned through the local CLI; Administrators can provision accounts, change roles, enable or disable accounts, and review the latest audit events in the console. Password reset delivery and a complete security audit review UI are not implemented.
- **Sole-administrator recovery:** preserve recovery codes in an approved secrets vault and provision a second Administrator where policy permits. If every admin recovery code is lost, stop the API, make a protected backup of the SQLite database, independently verify the admin's identity through organizational procedures, then run `npm run recover:admin-mfa` from an authorized local terminal. Supply the admin email and incident/ticket reference, then type the exact confirmation phrase. The operation is audited, revokes all sessions, and does not create a bypass: the next password login must enroll MFA again. Protect the database backup and restore it if the recovery operation is interrupted.
- No real-time event source is configured. Do not treat demo dashboard signals or decorative graph edges as financial evidence.

## Scripts

- `npm run dev` — local web app and API
- `npm run build` — TypeScript check and Vite production build
- `npm run lint` — ESLint
- `npm run provision:user` — provision a local Analyst or Administrator account
- `npm run recover:admin-mfa` — controlled offline recovery for a locked-out Administrator; requires the API to be stopped
- `npm run preview` — preview the built frontend (API deployment is separate unless served through the production Express process)

## Case reports

The investigation detail page generates JSON and PDF reports, an Excel `.xlsx` workbook, transaction CSV, and findings CSV from the selected case's saved backend records. Workbooks contain separate Case Summary, Transactions, Findings, and (when available) Accounts sheets. Saved investigation notes are included in reports. PDF reports include a severity-count overview and compact graph of observed case transactions. The case page also summarizes findings by severity/rule and highlights accounts referenced by findings in the existing transaction network. These summaries are not fraud scores: the application does not calculate transaction-level risk classifications or a numerical risk score. Analysis is deterministic and repeatable: matching findings are updated rather than deleted and recreated. Findings are review signals, not proof of fraud.

## Current implementation boundaries

Manual investigation cases, persistent imported transactions/findings, dataset-derived network views, report generation, Administrator account provisioning/activation/role controls, and an audit-event viewer are implemented. A live monitoring stream, Kafka/bank integration, password reset, and a production security review remain outstanding. No model accuracy, regulatory certification, or fraud determination is claimed.
