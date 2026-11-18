# Marketing Dashboard: overview

The Marketing Dashboard is the Succulents Box marketing team's internal workspace. Team members sign in with Google to see business and channel performance, product and vendor results, advertising, promotions, the gift calendar, tasks and frozen weekly or monthly reports in one place.

Figures come from the team's own reporting tools and planning files, which the dashboard reads but never edits. The dashboard keeps track of where each figure came from and which period it covers. Missing, partial or overlapping data is labelled instead of being filled in or counted twice. Opening a page only shows data that is already saved; it never starts an export or a scrape.

The code in this repository is public. Data, credentials, team membership and business rules live in private server settings and the team's private operator guide, never in Git. Tests and the local demo use synthetic data only.

## Local development

Requires Node.js and PostgreSQL 14 or later.

```bash
npm install
npm run db:demo     # synthetic demo data on a local database
npm test            # needs TEST_DATABASE_URL pointing at a throwaway database
npm run build
npm run check:public
```

Deployment, configuration and rollback steps are in the private operator guide.
