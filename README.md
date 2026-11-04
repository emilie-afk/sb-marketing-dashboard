# Marketing Dashboard

**Succulents Box · Marketing Workspace.** A private workspace for the marketing team: business performance and trends, advertising, promotions and seasonal programs, marketing tasks, products and vendors, Etsy listing reviews, and weekly and monthly reports. It is linked from the public Toolbox.

- Architecture and operator guide: [docs/GUIDE.md](docs/GUIDE.md)
- Intake spreadsheet and submission contract: [docs/INTAKE_SHEET.md](docs/INTAKE_SHEET.md)

Stack: React + TypeScript (Vite), one Netlify Function API, PostgreSQL (Neon), Google sign-in with server-side roles, Netlify Blobs for private files, one-way Google Sheets sync through the read-only Drive API.

```bash
npm install
export DATABASE_URL=postgresql://localhost/mkt
npm run db:demo                       # schema + synthetic demo data (local only)
TEST_DATABASE_URL=postgresql://localhost/mkt_test npm test
npm run build && npm run check:public
LOCAL_DEV_LOGIN=1 npm run dev         # http://localhost:8888/dev/login?role=editor
```

This repository is public. It holds code, synthetic fixtures and generic docs only. Team members, credentials, spreadsheet links, business scope rules and all data are set privately on the server or stored in the database. Run `npm run check:public` (with `PRIVATE_TERMS_FILE` set) before every push.
