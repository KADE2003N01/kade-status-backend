# Local database

The backend uses `database.sqlite` in this folder for the portfolio site and FolioSpace. The old `portfolio.sqlite` file remains as the source backup after the filename change.

The SQL that builds and updates tables lives in `../src/database/migrations/`. Open those numbered `.sql` files in the editor to inspect the table definitions and changes. `../src/database/database.js` runs the migrations when the backend starts.

From `kade-status-backend`, run `npm run db:schema` to print the current database's `CREATE TABLE` SQL in the terminal.

Useful SQLite commands from this directory:

```sql
.tables
.schema plans
.schema subscriptions
.schema platform_onboarding
PRAGMA table_info(subscriptions);
SELECT id, name, price_minor, currency, active FROM plans;
SELECT user_id, plan_id, state, period_end, grace_end, updated_at FROM subscriptions;
SELECT user_id, selected_template_id, stage, payment_status FROM platform_onboarding;
```

While billing is bypassed, new Standard and Professional accounts are recorded as paid and active to allow setup. This is a temporary application state; it does not mean a payment was collected.
